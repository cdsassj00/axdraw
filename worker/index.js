/**
 * axdraw share server — a Cloudflare Worker.
 *
 * Two endpoints over a KV namespace, plus static assets (the built app in
 * dist/). Bodies are opaque encrypted bytes: the browser encrypts before
 * uploading and keeps the key in the URL fragment, so nothing readable ever
 * reaches this Worker or KV.
 *
 *   POST /api/scenes        body: iv‖ciphertext   → { "id": "…" }
 *   GET  /api/scenes/:id                          → the same bytes
 *
 * CORS is open on purpose: ids are unguessable (60 bits) and the content is
 * ciphertext, so the origin of the reader adds no protection worth having,
 * while an open policy lets a GitHub Pages build use this Worker as its API.
 */

const MAX_BYTES = 20 * 1024 * 1024; // KV values cap at 25 MiB; leave headroom.
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function randomId(length = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let id = "";
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return id;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

/**
 * A collaboration room: relays every WebSocket frame to all other sockets in
 * the same room. Frames are opaque encrypted bytes (the key never leaves the
 * clients' URL fragments), so the room needs no logic beyond fan-out. Uses
 * the hibernation API so idle rooms cost nothing.
 */
export class Room {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws, message) {
    for (const peer of this.state.getWebSockets()) {
      if (peer !== ws) {
        try {
          peer.send(message);
        } catch {
          // A peer mid-disconnect; it will be reaped by the runtime.
        }
      }
    }
  }

  webSocketClose(ws) {
    try {
      ws.close();
    } catch {
      // Already closed.
    }
  }
}

// Groq retires model ids over time, so instead of hard-coding one we ask
// the API what exists and take the first preference that matches. Cached
// per isolate; a Worker restart re-resolves.
let groqModelCache = null;
const GROQ_PREFERENCES = [
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "llama-3.1-8b-instant",
];
async function pickGroqModel(key) {
  if (groqModelCache) return groqModelCache;
  try {
    const response = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!response.ok) return null;
    const { data } = await response.json();
    const ids = new Set((data ?? []).map((m) => m.id));
    const preferred = GROQ_PREFERENCES.find((id) => ids.has(id));
    // Otherwise any instruct-style llama/gpt model beats failing outright.
    const fallback = [...ids].find((id) => /llama|gpt|qwen/i.test(id) && !/whisper|tts|guard|vision/i.test(id));
    groqModelCache = preferred ?? fallback ?? null;
    return groqModelCache;
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      // Coffee sponsorship: approve a Toss Payments payment server-side.
      // The client key opens the payment window; nothing is charged until
      // this confirm call, made with the secret key that lives only in a
      // Worker secret (npx wrangler secret put TOSS_SECRET_KEY).
      if (url.pathname === "/api/coffee/confirm" && request.method === "POST") {
        if (!env.TOSS_SECRET_KEY) {
          return json({ error: "TOSS_SECRET_KEY is not configured" }, 501);
        }
        const { paymentKey, orderId, amount } = await request.json().catch(() => ({}));
        const ALLOWED_AMOUNTS = [3000, 5000, 10000];
        if (!paymentKey || !orderId || !ALLOWED_AMOUNTS.includes(amount)) {
          return json({ error: "invalid payment parameters" }, 400);
        }
        const confirm = await fetch("https://api.tosspayments.com/v1/payments/confirm", {
          method: "POST",
          headers: {
            authorization: `Basic ${btoa(`${env.TOSS_SECRET_KEY}:`)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ paymentKey, orderId, amount }),
        });
        const body = await confirm.text();
        return new Response(body, {
          status: confirm.status,
          headers: { "content-type": "application/json", ...CORS_HEADERS },
        });
      }

      // In-site AI drawing: proxy a prompt to a cheap chat model and return
      // an element spec the client turns into shapes. The key lives only in
      // a Worker secret — GROQ_API_KEY or OPENROUTER_API_KEY (Groq wins if
      // both are set); AI_MODEL optionally overrides the default model.
      if (url.pathname === "/api/ai/draw" && request.method === "POST") {
        const provider = env.GROQ_API_KEY
          ? {
              base: "https://api.groq.com/openai/v1",
              key: env.GROQ_API_KEY,
              model: env.AI_MODEL || (await pickGroqModel(env.GROQ_API_KEY)),
            }
          : env.OPENROUTER_API_KEY
            ? {
                base: "https://openrouter.ai/api/v1",
                key: env.OPENROUTER_API_KEY,
                model: env.AI_MODEL || "openai/gpt-4o-mini",
              }
            : null;
        if (!provider) return json({ error: "AI is not configured" }, 501);
        if (!provider.model) return json({ error: "no usable AI model found" }, 502);

        const { prompt } = await request.json().catch(() => ({}));
        if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 600) {
          return json({ error: "invalid prompt" }, 400);
        }

        const system = [
          "You lay out diagrams for a hand-drawn whiteboard. Reply with ONLY a JSON object:",
          '{"elements": [ ... ]}. Each element:',
          '{"type":"rectangle"|"ellipse"|"diamond"|"arrow"|"line"|"text",',
          ' "x":number, "y":number, "width":number, "height":number,',
          ' "label":"centred text on a shape (optional)",',
          ' "text":"content, only for type=text",',
          ' "points":[[0,0],[dx,dy],...] relative to (x,y), only for arrow/line,',
          ' "strokeColor":"#hex", "backgroundColor":"#hex fill for shapes",',
          ' "fontSize":number, "angle":radians (all optional)}',
          "Coordinates: y grows downward; keep the drawing within roughly 900x650 starting near (0,0).",
          "Shapes are typically 140-200 wide and 60-90 tall; leave 40-80px gaps; connect flow steps with arrows.",
          "Pleasant pastel fills: #a5d8ff blue, #b2f2bb green, #ffec99 yellow, #ffc9c9 red, #d0bfff purple.",
          "Write labels in the same language as the user's request. Maximum 60 elements. JSON only, no prose.",
        ].join("\n");

        const upstream = await fetch(`${provider.base}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${provider.key}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: provider.model,
            temperature: 0.4,
            max_tokens: 4000,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: system },
              { role: "user", content: prompt },
            ],
          }),
        });
        if (!upstream.ok) {
          const detail = await upstream.text();
          return json({ error: `AI request failed (${upstream.status})`, detail: detail.slice(0, 300) }, 502);
        }
        const completion = await upstream.json();
        const content = completion.choices?.[0]?.message?.content ?? "";
        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch {
          // Some models wrap the JSON in a code fence despite instructions.
          const inner = /\{[\s\S]*\}/.exec(content);
          if (!inner) return json({ error: "AI returned no JSON" }, 502);
          try {
            parsed = JSON.parse(inner[0]);
          } catch {
            return json({ error: "AI returned invalid JSON" }, 502);
          }
        }
        const elements = Array.isArray(parsed) ? parsed : parsed.elements;
        if (!Array.isArray(elements) || !elements.length) {
          return json({ error: "AI returned no elements" }, 502);
        }
        return json({ elements: elements.slice(0, 60) });
      }

      const room = /^\/api\/rooms\/([A-Za-z0-9]+)\/ws$/.exec(url.pathname);
      if (room) {
        return env.ROOMS.get(env.ROOMS.idFromName(room[1])).fetch(request);
      }

      if (url.pathname === "/api/scenes" && request.method === "POST") {
        const length = Number(request.headers.get("content-length") ?? 0);
        if (length > MAX_BYTES) return json({ error: "too large" }, 413);
        const body = await request.arrayBuffer();
        if (body.byteLength === 0) return json({ error: "empty body" }, 400);
        if (body.byteLength > MAX_BYTES) return json({ error: "too large" }, 413);
        const id = randomId();
        await env.SCENES.put(id, body);
        return json({ id });
      }

      const match = /^\/api\/scenes\/([A-Za-z0-9]+)$/.exec(url.pathname);
      if (match && request.method === "GET") {
        const body = await env.SCENES.get(match[1], { type: "arrayBuffer" });
        if (!body) return json({ error: "not found" }, 404);
        return new Response(body, {
          headers: {
            "content-type": "application/octet-stream",
            "cache-control": "public, max-age=31536000, immutable",
            ...CORS_HEADERS,
          },
        });
      }

      return json({ error: "not found" }, 404);
    }

    // Everything else is the static app.
    return env.ASSETS.fetch(request);
  },
};
