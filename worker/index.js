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
  "access-control-allow-headers": "content-type, x-ai-key",
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
let groqModelsCache = null;
async function listGroqModels(key) {
  if (groqModelsCache) return groqModelsCache;
  try {
    const response = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!response.ok) return new Set();
    const { data } = await response.json();
    groqModelsCache = new Set((data ?? []).map((m) => m.id));
    return groqModelsCache;
  } catch {
    return new Set();
  }
}
// Preference lists survive Groq's model retirements: first available wins,
// then any instruct-style model, then null (which surfaces as an error).
const DRAW_PREFERENCES = [
  "openai/gpt-oss-120b",
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-20b",
  "llama-3.1-8b-instant",
];
const CHAT_PREFERENCES = [
  "openai/gpt-oss-20b",
  "gemma2-9b-it",
  "llama-3.1-8b-instant",
  "openai/gpt-oss-120b",
];
async function pickGroqModel(key, preferences) {
  const ids = await listGroqModels(key);
  const preferred = preferences.find((id) => ids.has(id));
  const fallback = [...ids].find((id) => /llama|gpt|qwen|gemma/i.test(id) && !/whisper|tts|guard|vision/i.test(id));
  return preferred ?? fallback ?? null;
}

// Bring-your-own-key: a personal Groq key relayed by the client in the
// x-ai-key header. Used only for this request; never stored or logged.
// Server keys (secrets) win when configured. Model env overrides only
// apply to the server's own key.
async function resolveAiProvider(request, env, modelEnv, preferences) {
  const userKey = (request.headers.get("x-ai-key") || "").trim();
  if (env.GROQ_API_KEY) {
    return {
      base: "https://api.groq.com/openai/v1",
      key: env.GROQ_API_KEY,
      model: modelEnv || (await pickGroqModel(env.GROQ_API_KEY, preferences)),
    };
  }
  if (env.OPENROUTER_API_KEY) {
    return {
      base: "https://openrouter.ai/api/v1",
      key: env.OPENROUTER_API_KEY,
      model: modelEnv || "openai/gpt-4o-mini",
    };
  }
  if (userKey && /^gsk_[A-Za-z0-9_-]{10,200}$/.test(userKey)) {
    return {
      base: "https://api.groq.com/openai/v1",
      key: userKey,
      model: await pickGroqModel(userKey, preferences),
    };
  }
  return null;
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
        const provider = await resolveAiProvider(request, env, env.AI_MODEL, DRAW_PREFERENCES);
        if (!provider) return json({ error: "AI is not configured" }, 501);
        if (!provider.model) return json({ error: "no usable AI model found" }, 502);

        const { prompt } = await request.json().catch(() => ({}));
        if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 600) {
          return json({ error: "invalid prompt" }, 400);
        }

        const system = [
          "You are a diagram designer for a hand-drawn whiteboard. Reply with ONLY a JSON object:",
          '{"elements": [ ... ]}. Each element:',
          '{"type":"rectangle"|"ellipse"|"diamond"|"arrow"|"line"|"text",',
          ' "x":number, "y":number, "width":number, "height":number,',
          ' "label":"centred text on a shape (optional)",',
          ' "text":"content, only for type=text",',
          ' "x2":number, "y2":number — END point, only for arrow/line (start is x,y),',
          ' "strokeColor":"#hex", "backgroundColor":"#hex fill for shapes",',
          ' "fontSize":number, "angle":radians (all optional)}',
          "",
          "DESIGN RULES — follow all of them; they are what makes the result beautiful:",
          "1. Add a title: a text element at the top, fontSize 28, strokeColor #1e293b.",
          "2. Align to a grid. Same-role shapes share the exact same width, height, and x (columns) or y (rows). Column spacing 260-300, row spacing 130-150.",
          "3. Uniform shape size: main boxes 200x80. Decision diamonds 220x110. Terminal ellipses 180x76.",
          "4. Every flow step is CONNECTED with an arrow. Arrows run straight, never diagonal: a vertical arrow starts at the bottom-centre of a box (x = box.x + width/2, y = box.y + height) and ends at the top-centre of the next (x2 = same x, y2 = next box y). Horizontal arrows go right-centre to left-centre (same y). Arrow strokeColor #64748b.",
          "4b. Successive flow steps stack in ONE column (same x) or ONE row (same y). Branches move to a parallel column/row first, then continue straight. NEVER place consecutive steps diagonally.",
          "5. Consistent palette, one colour per role/branch. Fills: #dbeafe blue, #dcfce7 green, #fef9c3 yellow, #fee2e2 red, #f3e8ff purple, #ffedd5 orange. Matching stroke: #3b82f6, #22c55e, #eab308, #ef4444, #a855f7, #f97316. White #ffffff for neutral boxes.",
          "6. Short labels: 2-4 words, never sentences. Annotations go in separate small text elements (fontSize 14, strokeColor #64748b) beside the flow, not inside boxes.",
          "7. For mind maps: central ellipse, branches spread radially, every branch node linked to its parent with a line element whose points actually reach from parent edge to child edge.",
          "8. Be generous and complete: produce AT LEAST 15 elements (title + every step + every connector + 2-4 side annotations). A diagram with fewer than 15 elements is a failure.",
          "Coordinates: y grows downward; keep everything within 1100x750 starting near (0,0).",
          'Arrows and lines MUST use x,y (start) and x2,y2 (end). The key "points" is FORBIDDEN — never emit it.',
          "Write labels in the same language as the user's request. Maximum 60 elements. JSON only, no prose.",
        ].join("\n");

        const DIAGRAM_SCHEMA = {
          type: "object",
          properties: {
            elements: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["rectangle", "ellipse", "diamond", "arrow", "line", "text"] },
                  x: { type: "number" },
                  y: { type: "number" },
                  width: { type: "number" },
                  height: { type: "number" },
                  x2: { type: "number" },
                  y2: { type: "number" },
                  label: { type: "string" },
                  text: { type: "string" },
                  strokeColor: { type: "string" },
                  backgroundColor: { type: "string" },
                  fontSize: { type: "number" },
                },
                required: ["type", "x", "y"],
                additionalProperties: false,
              },
            },
          },
          required: ["elements"],
          additionalProperties: false,
        };

        const callModel = (responseFormat) =>
          fetch(`${provider.base}/chat/completions`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${provider.key}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: provider.model,
              temperature: 0.4,
              max_tokens: 8000,
              response_format: responseFormat,
              // gpt-oss models burn the budget on hidden reasoning otherwise.
              ...(provider.model.includes("gpt-oss") ? { reasoning_effort: "low" } : {}),
              messages: [
                { role: "system", content: system },
                { role: "user", content: prompt },
              ],
            }),
          });
        // Structured output guarantees numeric coordinates; fall back to
        // plain JSON mode for models that don't support json_schema.
        let upstream = await callModel({
          type: "json_schema",
          json_schema: { name: "diagram", schema: DIAGRAM_SCHEMA },
        });
        if (!upstream.ok && upstream.status === 400) {
          upstream = await callModel({ type: "json_object" });
        }
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

      // AI chat: a small assistant panel in the app. Same key handling as
      // /api/ai/draw; AI_CHAT_MODEL overrides the default chat model.
      if (url.pathname === "/api/ai/chat" && request.method === "POST") {
        const provider = await resolveAiProvider(request, env, env.AI_CHAT_MODEL, CHAT_PREFERENCES);
        if (!provider) return json({ error: "AI is not configured" }, 501);
        if (!provider.model) return json({ error: "no usable AI model found" }, 502);

        const { messages } = await request.json().catch(() => ({}));
        if (
          !Array.isArray(messages) ||
          !messages.length ||
          messages.length > 20 ||
          !messages.every(
            (m) =>
              m &&
              (m.role === "user" || m.role === "assistant") &&
              typeof m.content === "string" &&
              m.content.length <= 4000,
          )
        ) {
          return json({ error: "invalid messages" }, 400);
        }

        const upstream = await fetch(`${provider.base}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${provider.key}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: provider.model,
            temperature: 0.7,
            max_tokens: 1500,
            messages: [
              {
                role: "system",
                content:
                  "You are the assistant inside axdraw, a hand-drawn style whiteboard. " +
                  "Answer in the user's language, concisely and helpfully. Plain text only — no markdown headings or code fences. " +
                  "When the user asks for content that could go on the canvas (outlines, plans, summaries, lists), " +
                  "write it so it reads well as canvas text: short lines, one idea per line.",
              },
              ...messages,
            ],
          }),
        });
        if (!upstream.ok) {
          const detail = await upstream.text();
          return json({ error: `AI request failed (${upstream.status})`, detail: detail.slice(0, 300) }, 502);
        }
        const completion = await upstream.json();
        const reply = completion.choices?.[0]?.message?.content?.trim();
        if (!reply) return json({ error: "AI returned no reply" }, 502);
        return json({ reply });
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
