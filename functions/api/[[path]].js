import axdrawWorker from "../../worker/index.js";

const DEFAULT_SECTIONS = ["1교시: 개념 이해", "2교시: 실습 미션", "질문 있어요 🙋", "아이디어 / 피드백 💡"];

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const cf = request.cf || {};

  // Forward Durable Objects real-time collaboration rooms (/api/rooms/:id/ws & /scene) to axpad-ai-worker via Service Binding!
  if (/^\/api\/rooms\/[A-Za-z0-9]+\/(ws|scene)$/.test(path)) {
    return env.AI_SERVICE.fetch(request);
  }

  // Vectorize: Sync all board posts into axpad-posts-index
  if (path === "/api/vector/sync" && method === "POST") {
    const t0 = Date.now();
    const postsRes = await env.DB.prepare("SELECT id, board_slug, section, title, content FROM posts ORDER BY id DESC LIMIT 100").all();
    const items = postsRes.results || [];
    const vRes = await env.AI_SERVICE.fetch("https://ai-internal/vector/upsert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const vData = await vRes.json();
    return Response.json({
      ...vData,
      trace: {
        service: "Vectorize + AI Gateway",
        action: `포스트 ${vData.count || 0}건 벡터 DB 색인 완료`,
        durationMs: Date.now() - t0,
        detail: `AI.run("@cf/baai/bge-m3", gateway="axpad-gateway") -> VECTORIZE.upsert("axpad-posts-index")`,
        explain: "게시글을 1024차원 한국어 임베딩 벡터로 변환해 Cloudflare Vectorize에 저장했습니다.",
      },
    });
  }

  // Vectorize: Semantic search (RAG)
  if (path === "/api/search" && method === "POST") {
    const { query = "", slug = "" } = await request.json();
    const t0 = Date.now();
    const vRes = await env.AI_SERVICE.fetch("https://ai-internal/vector/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, board_slug: slug }),
    });
    const vData = await vRes.json();
    return Response.json({
      ...vData,
      trace: {
        service: "Vectorize + AI Gateway",
        action: `AI 의미 검색 ("${query}") → ${(vData.matches || []).length}건 매칭`,
        durationMs: Date.now() - t0,
        detail: `VECTORIZE.query("axpad-posts-index", topK=8, metric="cosine") via axpad-gateway`,
        explain: "단어가 정확히 일치하지 않아도 문장 의미를 벡터 유사도(Cosine)로 계산해 가장 비슷한 포스트잇을 찾았습니다!",
      },
    });
  }

  if (path === "/api/boards" && method === "GET") {
    const t0 = Date.now();
    const res = await env.DB.prepare(
      "SELECT b.slug, b.title, b.created_at, COUNT(p.id) as post_count FROM boards b LEFT JOIN posts p ON p.board_slug = b.slug GROUP BY b.slug ORDER BY b.created_at DESC"
    ).all();
    return Response.json({
      ok: true,
      boards: res.results || [],
      trace: {
        service: "D1 SQLite",
        action: `클라우드 게시판 ${(res.results || []).length}개 조회`,
        durationMs: Date.now() - t0,
        detail: "SELECT b.slug, b.title, COUNT(p.id) FROM boards...",
        explain: "Cloudflare D1에 모든 강의 게시판이 영구 저장됩니다.",
      },
    });
  }

  if (path === "/api/boards" && method === "POST") {
    const { title, slug: rawSlug } = await request.json();
    if (!title) return Response.json({ ok: false, error: "제목이 필요합니다." }, { status: 400 });
    const slug = (rawSlug || "AX" + Math.random().toString(36).slice(2, 6)).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    const t0 = Date.now();
    await env.DB.prepare("INSERT INTO boards (slug, title, notice, sections_json, locked) VALUES (?, ?, ?, ?, 0)")
      .bind(slug, title, `🎉 ${title}`, JSON.stringify(DEFAULT_SECTIONS))
      .run();
    return Response.json({
      ok: true,
      slug,
      trace: {
        service: "D1 SQLite",
        action: `새 클라우드 게시판 생성 (${slug})`,
        durationMs: Date.now() - t0,
        detail: `INSERT INTO boards (slug, title) VALUES ("${slug}", "${title}");`,
        explain: "새 게시판이 D1 클라우드에 생성되었습니다.",
      },
    });
  }

  const secPostMatch = path.match(/^\/api\/boards\/([^/]+)\/sections$/);
  if (secPostMatch && method === "POST") {
    const slug = decodeURIComponent(secPostMatch[1]).toUpperCase();
    const { sections } = await request.json();
    const t0 = Date.now();
    await env.DB.prepare("UPDATE boards SET sections_json = ? WHERE slug = ?").bind(JSON.stringify(sections), slug).run();
    return Response.json({
      ok: true,
      sections,
      trace: {
        service: "D1 SQLite",
        action: `원클릭 카테고리 저장 (${sections.length}개)`,
        durationMs: Date.now() - t0,
        detail: `UPDATE boards SET sections_json = ... WHERE slug = "${slug}";`,
        explain: "새 카테고리가 D1에 즉시 반영되었습니다.",
      },
    });
  }

  if (path === "/api/board" && method === "GET") {
    const slug = (url.searchParams.get("slug") || "AX2026").toUpperCase();
    const traces = [
      {
        service: "Pages Edge",
        action: "글로벌 엣지 라우팅 (request.cf)",
        durationMs: 0,
        detail: `colo: ${cf.colo || "EDGE"} | country: ${cf.country || "KR"}`,
        explain: "가장 가까운 Cloudflare 엣지 데이터센터에서 응답했습니다.",
      },
    ];
    const tKv = Date.now();
    const visits = (Number(await env.KV.get("visits:" + slug)) || 0) + 1;
    await env.KV.put("visits:" + slug, String(visits));
    traces.push({
      service: "KV Store",
      action: `보드(${slug}) 방문수 카운트`,
      durationMs: Date.now() - tKv,
      detail: `KV.put("visits:${slug}", "${visits}")`,
      explain: "초고속 글로벌 키-값 저장소(KV)에 방문수를 기록했습니다.",
    });

    const tDb = Date.now();
    let boardRow = await env.DB.prepare("SELECT * FROM boards WHERE slug = ?").bind(slug).first();
    if (!boardRow) {
      await env.DB.prepare("INSERT OR IGNORE INTO boards (slug, title, notice, sections_json, locked) VALUES (?, ?, ?, ?, 0)")
        .bind(slug, slug + " 강의 보드", "새 클라우드 보드", JSON.stringify(DEFAULT_SECTIONS))
        .run();
      boardRow = await env.DB.prepare("SELECT * FROM boards WHERE slug = ?").bind(slug).first();
    }
    const postsRes = await env.DB.prepare("SELECT * FROM posts WHERE board_slug = ? ORDER BY id DESC").bind(slug).all();
    const commentsRes = await env.DB.prepare("SELECT * FROM comments ORDER BY id ASC").all();
    const byPost = {};
    for (const c of commentsRes.results || []) (byPost[c.post_id] = byPost[c.post_id] || []).push(c);
    const posts = (postsRes.results || []).map((p) => ({ ...p, comments: byPost[p.id] || [] }));
    traces.push({
      service: "D1 SQLite",
      action: `카드 ${posts.length}건 & 댓글 조회`,
      durationMs: Date.now() - tDb,
      detail: `SELECT * FROM posts WHERE board_slug="${slug}"`,
      explain: "D1 SQLite에서 게시글과 댓글을 조회했습니다.",
    });

    let sections = DEFAULT_SECTIONS;
    try {
      sections = JSON.parse(boardRow.sections_json);
    } catch {}
    return Response.json({
      ok: true,
      edge: { colo: cf.colo || "EDGE", country: cf.country || "KR" },
      visits,
      board: { slug: boardRow.slug, title: boardRow.title, notice: boardRow.notice, locked: Boolean(boardRow.locked), sections },
      posts,
      traces,
    });
  }

  if (path === "/api/upload" && method === "POST") {
    const t0 = Date.now();
    const form = await request.formData();
    const file = form.get("file");
    if (!file) return Response.json({ ok: false, error: "파일 없음" }, { status: 400 });
    const buf = await file.arrayBuffer();
    const origName = file.name || "file";
    const ext = origName.includes(".") ? origName.split(".").pop().replace(/[^a-zA-Z0-9]/g, "").toLowerCase() : "bin";
    const key = `files/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext || "bin"}`;
    const contentType = file.type || "application/octet-stream";
    await env.R2.put(key, buf, {
      httpMetadata: { contentType },
      customMetadata: { filename: origName },
    });
    return Response.json({
      ok: true,
      key,
      name: origName,
      type: contentType,
      size: buf.byteLength,
      trace: {
        service: "R2 Storage",
        action: `강의 자료/파일 R2 업로드 (${origName})`,
        durationMs: Date.now() - t0,
        detail: `R2.put("${key}", ${(buf.byteLength / 1024).toFixed(1)} KB, "${contentType}")`,
        explain: "PDF·PPT·문서·압축파일·이미지 등 모든 파일을 전송료(Egress) 무료인 Cloudflare R2에 저장했습니다.",
      },
    });
  }

  if (path.startsWith("/api/media/") && method === "GET") {
    const key = decodeURIComponent(path.slice("/api/media/".length));
    const obj = await env.R2.get(key);
    if (!obj) return new Response("Not Found", { status: 404 });
    const filename = obj.customMetadata?.filename || key.split("/").pop() || "download";
    const headers = {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
    };
    if (url.searchParams.get("download") === "1") {
      headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
    }
    return new Response(obj.body, { headers });
  }

  if (path === "/api/posts" && method === "POST") {
    const b = await request.json();
    const slug = (b.board_slug || "AX2026").toUpperCase();
    const t0 = Date.now();
    let linkUrl = (b.link_url || "").trim();
    if (linkUrl && !/^https?:\/\//i.test(linkUrl)) linkUrl = "https://" + linkUrl;
    const ins = await env.DB.prepare(
      "INSERT INTO posts (board_slug, section, author, title, content, color, media_key, media_type, media_name, media_size, link_url, pos_x, pos_y) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        slug,
        b.section || DEFAULT_SECTIONS[0],
        b.author || "수강생",
        b.title,
        b.content,
        b.color || "yellow",
        b.media_key || null,
        b.media_type || null,
        b.media_name || null,
        b.media_size || null,
        linkUrl || null,
        60,
        60
      )
      .run();
    const newId = ins.meta?.last_row_id;
    if (newId && context.waitUntil) {
      context.waitUntil(
        env.AI_SERVICE.fetch("https://ai-internal/vector/upsert", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: [{ id: newId, board_slug: slug, section: b.section || DEFAULT_SECTIONS[0], title: b.title, content: b.content }] }),
        }).catch(() => {})
      );
    }
    return Response.json({
      ok: true,
      id: newId,
      trace: {
        service: "D1 SQLite + Vectorize",
        action: `새 포스트잇 저장 & 벡터 자동 색인 (${slug})`,
        durationMs: Date.now() - t0,
        detail: `INSERT INTO posts (...) + waitUntil(VECTORIZE.upsert("post-${newId}"))`,
        explain: "D1 클라우드에 저장함과 동시에 백그라운드(waitUntil)에서 Vectorize 의미 검색 인덱스에도 자동 등록했습니다.",
      },
    });
  }

  const likeMatch = path.match(/^\/api\/posts\/(\d+)\/like$/);
  if (likeMatch && method === "POST") {
    const pid = Number(likeMatch[1]);
    const t0 = Date.now();
    await env.DB.prepare("UPDATE posts SET likes = likes + 1 WHERE id = ?").bind(pid).run();
    const row = await env.DB.prepare("SELECT likes FROM posts WHERE id = ?").bind(pid).first();
    return Response.json({
      ok: true,
      likes: row?.likes ?? 0,
      trace: { service: "D1 SQLite", action: `카드 #${pid} 좋아요 +1`, durationMs: Date.now() - t0, detail: `UPDATE posts SET likes = likes + 1 WHERE id = ${pid};`, explain: "SQL UPDATE로 좋아요를 증가시켰습니다." },
    });
  }

  const cmtMatch = path.match(/^\/api\/posts\/(\d+)\/comments$/);
  if (cmtMatch && method === "POST") {
    const pid = Number(cmtMatch[1]);
    const { author, content } = await request.json();
    const t0 = Date.now();
    await env.DB.prepare("INSERT INTO comments (post_id, author, content) VALUES (?, ?, ?)").bind(pid, author || "수강생", content).run();
    return Response.json({
      ok: true,
      trace: { service: "D1 SQLite", action: `카드 #${pid} 댓글 추가`, durationMs: Date.now() - t0, detail: `INSERT INTO comments (post_id, author) VALUES (${pid}, "${author}");`, explain: "외래키로 댓글을 저장했습니다." },
    });
  }

  const delMatch = path.match(/^\/api\/posts\/(\d+)$/);
  if (delMatch && method === "DELETE") {
    const pid = Number(delMatch[1]);
    const t0 = Date.now();
    await env.DB.prepare("DELETE FROM comments WHERE post_id = ?").bind(pid).run();
    await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(pid).run();
    return Response.json({
      ok: true,
      traces: [{ service: "D1 SQLite", action: `카드 #${pid} 삭제`, durationMs: Date.now() - t0, detail: `DELETE FROM posts WHERE id = ${pid};`, explain: "게시글과 댓글을 삭제했습니다." }],
    });
  }

  if (path === "/api/ai" && method === "POST") {
    const { mode = "summary", slug = "AX2026" } = await request.json();
    const postsRes = await env.DB.prepare("SELECT section, author, title, content FROM posts WHERE board_slug = ? ORDER BY id DESC LIMIT 30").bind(slug.toUpperCase()).all();
    const t0 = Date.now();
    const aiRes = await env.AI_SERVICE.fetch("https://ai-internal/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ posts: postsRes.results || [], mode }),
    });
    const aiData = await aiRes.json();
    return Response.json({
      ok: aiData.ok,
      answer: aiData.answer,
      error: aiData.error,
      trace: {
        service: "Workers AI + AI Gateway",
        action: mode === "quiz" ? "보드 기반 AI 퀴즈 생성" : "보드 전체 AI 요약",
        durationMs: Date.now() - t0,
        detail: `AI_SERVICE -> AI Gateway("axpad-gateway") -> @cf/meta/llama-3.3-70b-instruct-fp8-fast`,
        explain: "Service Binding(0ms) + AI Gateway(로그·캐싱·토큰 분석)를 거쳐 Cloudflare GPU LLM을 실행했습니다.",
      },
    });
  }

  // Delegate all axdraw native APIs (/api/cloud/*, /api/account/*, /api/scenes*, /api/rooms/*, /api/ai/*)
  const mappedEnv = {
    ...env,
    DB: env.DB,
    ROOM_SCENES: env.R2,
    SCENES: env.KV,
  };
  return axdrawWorker.fetch(request, mappedEnv);
}
