/**
 * AXPad Unified Cloudflare Backend Worker (axpad-ai-worker)
 * Powers:
 *  - Durable Objects (Room): Real-time WebSocket collaboration + serialized R2 scene saves
 *  - Workers AI + AI Gateway (axpad-gateway): Board summary & quiz generation
 *  - Vectorize (axpad-posts-index) + BGE-M3: Korean semantic search (RAG)
 *  - Cron Triggers: Scheduled board stats heartbeat to KV
 */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-base-version",
  "access-control-expose-headers": "x-room-store, x-room-version",
};

/** Durable Object: Real-time collaboration room with WebSocket Hibernation */
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.queue = Promise.resolve();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const scene = /^\/api\/rooms\/([A-Za-z0-9]+)\/scene$/.exec(url.pathname);
    if (scene) return this.scene(request, scene[1]);
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  serial(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async version() {
    return (await this.state.storage.get("version")) ?? 0;
  }

  async scene(request, id) {
    const key = "rooms/" + id;
    if (request.method === "GET") {
      const version = await this.version();
      const obj = await this.env.ROOM_SCENES.get(key);
      const headers = { "x-room-store": "r2", "x-room-version": String(version), ...CORS };
      if (!obj) {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json", ...headers },
        });
      }
      return new Response(obj.body, {
        headers: { "content-type": "application/octet-stream", "cache-control": "no-store", ...headers },
      });
    }
    if (request.method === "PUT") {
      const body = await request.arrayBuffer();
      if (body.byteLength === 0) return Response.json({ error: "empty body" }, { status: 400, headers: CORS });
      const baseHeader = request.headers.get("x-base-version");
      const base = baseHeader === null ? null : Number(baseHeader);
      return this.serial(async () => {
        const current = await this.version();
        if (base !== null && Number.isFinite(base) && base !== current) {
          return Response.json({ error: "conflict", version: current }, { status: 409, headers: CORS });
        }
        await this.env.ROOM_SCENES.put(key, body);
        const next = current + 1;
        await this.state.storage.put("version", next);
        return Response.json({ ok: true, version: next }, { headers: CORS });
      });
    }
    return Response.json({ error: "method not allowed" }, { status: 405, headers: CORS });
  }

  webSocketMessage(sender, message) {
    for (const socket of this.state.getWebSockets()) {
      if (socket === sender) continue;
      try {
        socket.send(message);
      } catch {
        // Peer disconnected
      }
    }
  }

  webSocketClose(socket, code, reason) {
    try {
      socket.close(code, reason);
    } catch {}
  }

  webSocketError(socket) {
    try {
      socket.close(1011, "error");
    } catch {}
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Durable Object Room proxy (for Pages Service Binding or direct WS/scene)
    const roomWs = /^\/api\/rooms\/([A-Za-z0-9]+)\/ws$/.exec(path);
    if (roomWs) {
      return env.ROOMS.get(env.ROOMS.idFromName(roomWs[1])).fetch(request);
    }
    const roomScene = /^\/api\/rooms\/([A-Za-z0-9]+)\/scene$/.exec(path);
    if (roomScene) {
      return env.ROOMS.get(env.ROOMS.idFromName(roomScene[1])).fetch(request);
    }

    // 2. Vectorize: Upsert posts into axpad-posts-index using BGE-M3
    if (path === "/vector/upsert" && request.method === "POST") {
      const t0 = Date.now();
      try {
        const { items = [] } = await request.json();
        if (!items.length) return Response.json({ ok: true, count: 0, durationMs: 0 });
        const texts = items.map((it) => `[${it.section || ""}] ${it.title || ""}\n${it.content || ""}`);
        const emb = await env.AI.run(
          "@cf/baai/bge-m3",
          { text: texts },
          { gateway: { id: "axpad-gateway" } }
        );
        const vectors = items.map((it, i) => ({
          id: `post-${it.id}`,
          values: emb.data[i],
          metadata: {
            post_id: Number(it.id),
            board_slug: String(it.board_slug || "AX2026"),
            section: String(it.section || ""),
            title: String(it.title || ""),
          },
        }));
        await env.VECTORIZE.upsert(vectors);
        return Response.json({
          ok: true,
          count: vectors.length,
          model: "@cf/baai/bge-m3",
          gateway: "axpad-gateway",
          durationMs: Date.now() - t0,
        });
      } catch (err) {
        return Response.json({ ok: false, error: err.message, durationMs: Date.now() - t0 }, { status: 500 });
      }
    }

    // 3. Vectorize: Semantic search in Korean via BGE-M3 + AI Gateway
    if (path === "/vector/search" && request.method === "POST") {
      const t0 = Date.now();
      try {
        const { query = "", board_slug = "" } = await request.json();
        if (!query.trim()) return Response.json({ ok: true, matches: [], durationMs: 0 });
        const emb = await env.AI.run(
          "@cf/baai/bge-m3",
          { text: [query.trim()] },
          { gateway: { id: "axpad-gateway" } }
        );
        const res = await env.VECTORIZE.query(emb.data[0], { topK: 8, returnMetadata: "all" });
        let matches = (res.matches || []).map((m) => ({
          id: m.id,
          post_id: m.metadata?.post_id,
          board_slug: m.metadata?.board_slug,
          title: m.metadata?.title,
          score: Number((m.score || 0).toFixed(3)),
        }));
        if (board_slug) {
          matches = matches.filter((m) => !m.board_slug || m.board_slug === board_slug.toUpperCase());
        }
        return Response.json({
          ok: true,
          matches,
          model: "@cf/baai/bge-m3",
          gateway: "axpad-gateway",
          durationMs: Date.now() - t0,
        });
      } catch (err) {
        return Response.json({ ok: false, error: err.message, durationMs: Date.now() - t0 }, { status: 500 });
      }
    }

    // 4. Workers AI + AI Gateway: Board Summary / Quiz
    if (path === "/run" && request.method === "POST") {
      const t0 = Date.now();
      try {
        const { posts = [], mode = "summary" } = await request.json();
        const textList = posts
          .map((p, i) => `[${i + 1}] (${p.section} / ${p.author}) ${p.title}: ${p.content}`)
          .join("\n");
        const systemPrompt =
          mode === "quiz"
            ? "너는 친절한 클라우드플레어 강사 AI 조교다. 아래 강의 보드의 포스트잇 내용을 바탕으로 수강생에게 낼 수 있는 객관식 확인 퀴즈 2문제와 정답/해설을 한국어로 깔끔하게 작성해줘."
            : "너는 친절한 강의 보조 AI다. 아래 패들렛 강의 보드에 올라온 수강생과 강사의 포스트잇들을 읽고, 1) 핵심 3줄 요약, 2) 주요 키워드 3~5개, 3) 다음 수업 제안 1가지를 한국어로 깔끔하게 정리해줘.";
        const model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
        const aiRes = await env.AI.run(
          model,
          {
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: textList || "게시글이 아직 없습니다." },
            ],
            max_tokens: 700,
          },
          { gateway: { id: "axpad-gateway" } }
        );
        const answer = aiRes?.response || aiRes?.choices?.[0]?.message?.content || JSON.stringify(aiRes);
        return Response.json({
          ok: true,
          model,
          gateway: "axpad-gateway",
          durationMs: Date.now() - t0,
          answer,
        });
      } catch (err) {
        return Response.json({ ok: false, error: err.message, durationMs: Date.now() - t0 }, { status: 500 });
      }
    }

    // 5. Status / Cron heartbeat check
    const cronLast = await env.KV.get("cron:last_run", "json");
    return Response.json({
      ok: true,
      service: "axpad-ai-worker",
      features: ["Durable Objects (Room)", "Workers AI", "AI Gateway (axpad-gateway)", "Vectorize (axpad-posts-index)", "Cron Triggers"],
      cronLast,
    });
  },

  /** Cron Trigger: runs every 6 hours and records board stats snapshot to KV */
  async scheduled(event, env) {
    const boards = await env.DB.prepare("SELECT COUNT(*) as cnt FROM boards").first();
    const posts = await env.DB.prepare("SELECT COUNT(*) as cnt FROM posts").first();
    await env.KV.put(
      "cron:last_run",
      JSON.stringify({
        ranAt: new Date().toISOString(),
        cron: event.cron,
        boardsCount: boards?.cnt ?? 0,
        postsCount: posts?.cnt ?? 0,
      })
    );
  },
};
