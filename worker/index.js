/**
 * axdraw share server — a Cloudflare Worker.
 *
 * Two endpoints over a KV namespace, plus static assets (the built app in
 * dist/). Bodies are opaque encrypted bytes: the browser encrypts before
 * uploading and keeps the key in the URL fragment, so nothing readable ever
 * reaches this Worker or KV.
 *
 *   POST /api/scenes             body: iv‖ciphertext   → { "id": "…" }
 *   GET  /api/scenes/:id                               → the same bytes
 *   PUT  /api/rooms/:id/scene    body: iv‖ciphertext   → { "ok": true }
 *   GET  /api/rooms/:id/scene                          → the same bytes
 *
 *   POST   /api/cloud/register      email + consents     → { "workspace": "…" }
 *   GET    /api/cloud/canvases      (Bearer)             → [{ id, name, updated }]
 *   GET    /api/cloud/canvases/:id  (Bearer)             → iv‖ciphertext
 *   PUT    /api/cloud/canvases/:id  (Bearer, x-base-version) → { updated } | 409
 *   DELETE /api/cloud/canvases/:id  (Bearer)
 *   GET|DELETE /api/cloud/account, POST /api/cloud/consent  (Bearer)
 *
 * CORS is open on purpose: ids are unguessable (60 bits) and the content is
 * ciphertext, so the origin of the reader adds no protection worth having,
 * while an open policy lets a GitHub Pages build use this Worker as its API.
 */

const MAX_BYTES = 20 * 1024 * 1024; // KV values cap at 25 MiB; leave headroom.
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, x-ai-key, authorization, x-canvas-name, x-base-version",
  "access-control-expose-headers": "x-room-store, x-canvas-updated",
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

/**
 * Where a room's scene is kept.
 *
 * R2 when it is bound, KV otherwise. The payload is an opaque encrypted blob
 * that is rewritten every few seconds while a room is in use, which is object
 * storage's job, not a database's — there is nothing to query inside
 * ciphertext, so a JSON column would buy nothing and cost the size limit. KV
 * works but allows only one write per second per key and 1,000 writes a day
 * on the free plan, which a single busy classroom exhausts; R2 has room to
 * spare. The fallback keeps deploys working before the bucket exists.
 *
 * Enable R2 with:
 *   npx wrangler r2 bucket create axdraw-rooms
 * then add to wrangler.toml:
 *   [[r2_buckets]]
 *   binding = "ROOM_SCENES"
 *   bucket_name = "axdraw-rooms"
 */
async function putRoomScene(env, id, body) {
  if (env.ROOM_SCENES) {
    await env.ROOM_SCENES.put(`room/${id}`, body);
    return;
  }
  await env.SCENES.put(`room:${id}`, body);
}

async function getRoomScene(env, id) {
  if (env.ROOM_SCENES) {
    const object = await env.ROOM_SCENES.get(`room/${id}`);
    return object ? await object.arrayBuffer() : null;
  }
  return env.SCENES.get(`room:${id}`, { type: "arrayBuffer" });
}

/**
 * Which store answered. R2 is read-after-write consistent, so a miss there
 * means the room really is empty; KV is eventually consistent (measured at
 * ~40s), so a miss may just be a scene that has not propagated yet. The
 * client needs to tell those apart: writing over the second kind destroys
 * work.
 */
function roomStoreName(env) {
  return env.ROOM_SCENES ? "r2" : "kv";
}

/* ------------------------------------------------------------------ *
 * Cloud canvases — every canvas kept on the server, behind an email.
 *
 * Free for everyone; leaving an email (plus an optional newsletter opt-in)
 * is what switches it on. Metadata and consent records live in D1 so they
 * can be queried and exported; the drawings themselves go to R2, encrypted
 * in the browser exactly like share links and rooms. The key never reaches
 * this Worker: it only ever sees ciphertext, a SHA-256 of the access token,
 * and the email the user typed.
 *
 * Enable with:
 *   npx wrangler d1 create axdraw-db
 * and paste the printed [[d1_databases]] block into wrangler.toml with
 * binding = "DB". The tables create themselves on first use.
 * ------------------------------------------------------------------ */

const CONSENT_VERSION = "2026-10-06";
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS leads (
     email TEXT PRIMARY KEY,
     privacy_consent_at INTEGER NOT NULL,
     marketing_consent INTEGER NOT NULL DEFAULT 0,
     marketing_consent_at INTEGER,
     consent_version TEXT NOT NULL,
     source TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS workspaces (
     id TEXT PRIMARY KEY,
     token_hash TEXT NOT NULL,
     email TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_seen INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS canvases (
     workspace_id TEXT NOT NULL,
     id TEXT NOT NULL,
     name TEXT NOT NULL,
     size INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (workspace_id, id)
   )`,
  `CREATE INDEX IF NOT EXISTS workspaces_email ON workspaces (email)`,
];

let schemaReady = null;
function ensureSchema(db) {
  // Once per isolate. A failure is not cached, so the next request retries.
  schemaReady ??= db.batch(SCHEMA.map((sql) => db.prepare(sql))).catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison for equal-length hex digests. */
function sameDigest(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Resolves `Authorization: Bearer <workspace>.<token>` to a workspace row. */
async function authenticate(request, env) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9]{10,40})\.([A-Za-z0-9_-]{20,100})$/.exec(header);
  if (!match) return null;
  const row = await env.DB.prepare("SELECT id, token_hash, email FROM workspaces WHERE id = ?")
    .bind(match[1])
    .first();
  if (!row) return null;
  if (!sameDigest(row.token_hash, await sha256Hex(match[2]))) return null;
  return row;
}

function canvasKey(workspace, id) {
  return `canvas/${workspace}/${id}`;
}

async function putCanvasBody(env, workspace, id, body) {
  if (env.ROOM_SCENES) return env.ROOM_SCENES.put(canvasKey(workspace, id), body);
  return env.SCENES.put(canvasKey(workspace, id), body);
}

async function getCanvasBody(env, workspace, id) {
  if (env.ROOM_SCENES) {
    const object = await env.ROOM_SCENES.get(canvasKey(workspace, id));
    return object ? object.arrayBuffer() : null;
  }
  return env.SCENES.get(canvasKey(workspace, id), { type: "arrayBuffer" });
}

async function deleteCanvasBody(env, workspace, id) {
  if (env.ROOM_SCENES) return env.ROOM_SCENES.delete(canvasKey(workspace, id));
  return env.SCENES.delete(canvasKey(workspace, id));
}

async function handleCloud(request, env, url) {
  if (!env.DB) return json({ error: "cloud storage is not configured" }, 503);
  await ensureSchema(env.DB);
  const now = Date.now();

  if (url.pathname === "/api/cloud/register" && request.method === "POST") {
    const { email, privacy, marketing, token, source } = await request.json().catch(() => ({}));
    const address = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!EMAIL_PATTERN.test(address) || address.length > 254) return json({ error: "invalid email" }, 400);
    // The required consent is a precondition, not a preference.
    if (privacy !== true) return json({ error: "privacy consent is required" }, 400);
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) {
      return json({ error: "invalid token" }, 400);
    }
    const workspace = randomId(16);
    const optIn = marketing === true ? 1 : 0;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO leads (email, privacy_consent_at, marketing_consent, marketing_consent_at, consent_version, source, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?2, ?2)
         ON CONFLICT(email) DO UPDATE SET
           privacy_consent_at = ?2,
           marketing_consent = CASE WHEN ?3 = 1 THEN 1 ELSE leads.marketing_consent END,
           marketing_consent_at = CASE WHEN ?3 = 1 THEN ?2 ELSE leads.marketing_consent_at END,
           consent_version = ?5,
           updated_at = ?2`,
      ).bind(address, now, optIn, optIn ? now : null, CONSENT_VERSION, typeof source === "string" ? source.slice(0, 40) : null),
      env.DB.prepare(
        "INSERT INTO workspaces (id, token_hash, email, created_at, last_seen) VALUES (?, ?, ?, ?, ?)",
      ).bind(workspace, await sha256Hex(token), address, now, now),
    ]);
    return json({ workspace });
  }

  const account = await authenticate(request, env);
  if (!account) return json({ error: "unauthorized" }, 401);

  if (url.pathname === "/api/cloud/account" && request.method === "GET") {
    const lead = await env.DB.prepare("SELECT marketing_consent FROM leads WHERE email = ?")
      .bind(account.email)
      .first();
    return json({ email: account.email, marketing: lead?.marketing_consent === 1 });
  }

  // Newsletter opt-in or withdrawal — withdrawing must be as easy as opting in.
  if (url.pathname === "/api/cloud/consent" && request.method === "POST") {
    const { marketing } = await request.json().catch(() => ({}));
    if (typeof marketing !== "boolean") return json({ error: "invalid consent" }, 400);
    await env.DB.prepare(
      "UPDATE leads SET marketing_consent = ?, marketing_consent_at = ?, updated_at = ? WHERE email = ?",
    )
      .bind(marketing ? 1 : 0, now, now, account.email)
      .run();
    return json({ ok: true });
  }

  // Deletes every canvas and the account. The lead goes too unless another
  // workspace (another device) still uses the same address.
  if (url.pathname === "/api/cloud/account" && request.method === "DELETE") {
    const { results } = await env.DB.prepare("SELECT id FROM canvases WHERE workspace_id = ?")
      .bind(account.id)
      .all();
    await Promise.all((results ?? []).map((row) => deleteCanvasBody(env, account.id, row.id)));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM canvases WHERE workspace_id = ?").bind(account.id),
      env.DB.prepare("DELETE FROM workspaces WHERE id = ?").bind(account.id),
      env.DB.prepare(
        "DELETE FROM leads WHERE email = ? AND NOT EXISTS (SELECT 1 FROM workspaces WHERE email = ?)",
      ).bind(account.email, account.email),
    ]);
    return json({ ok: true });
  }

  if (url.pathname === "/api/cloud/canvases" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, name, size, updated_at AS updated FROM canvases WHERE workspace_id = ? ORDER BY updated_at DESC",
    )
      .bind(account.id)
      .all();
    await env.DB.prepare("UPDATE workspaces SET last_seen = ? WHERE id = ?").bind(now, account.id).run();
    return json({ canvases: results ?? [] });
  }

  const canvas = /^\/api\/cloud\/canvases\/([A-Za-z0-9_-]{1,40})$/.exec(url.pathname);
  if (canvas) {
    const id = canvas[1];
    const row = await env.DB.prepare("SELECT updated_at FROM canvases WHERE workspace_id = ? AND id = ?")
      .bind(account.id, id)
      .first();

    if (request.method === "GET") {
      if (!row) return json({ error: "not found" }, 404);
      const body = await getCanvasBody(env, account.id, id);
      if (!body) return json({ error: "not found" }, 404);
      return new Response(body, {
        headers: {
          "content-type": "application/octet-stream",
          "cache-control": "no-store",
          "x-canvas-updated": String(row.updated_at),
          ...CORS_HEADERS,
        },
      });
    }

    if (request.method === "PUT") {
      // Optimistic concurrency: a device that has not seen the latest save
      // must merge it first instead of writing over another device's work.
      const base = Number(request.headers.get("x-base-version") ?? 0);
      if (row && row.updated_at > base) return json({ error: "conflict", updated: row.updated_at }, 409);
      const name = request.headers.get("x-canvas-name") ?? "";
      if (!/^[A-Za-z0-9_-]{1,2000}$/.test(name)) return json({ error: "invalid name" }, 400);
      const length = Number(request.headers.get("content-length") ?? 0);
      if (length > MAX_BYTES) return json({ error: "too large" }, 413);
      const body = await request.arrayBuffer();
      if (body.byteLength === 0) return json({ error: "empty body" }, 400);
      if (body.byteLength > MAX_BYTES) return json({ error: "too large" }, 413);
      // Strictly increasing even within one millisecond, so a device's own
      // previous save never looks newer than what it is building on.
      const updated = Math.max(now, (row?.updated_at ?? 0) + 1);
      await putCanvasBody(env, account.id, id, body);
      await env.DB.prepare(
        `INSERT INTO canvases (workspace_id, id, name, size, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, id) DO UPDATE SET name = excluded.name, size = excluded.size, updated_at = excluded.updated_at`,
      )
        .bind(account.id, id, name, body.byteLength, updated)
        .run();
      return json({ ok: true, updated });
    }

    if (request.method === "DELETE") {
      await deleteCanvasBody(env, account.id, id);
      await env.DB.prepare("DELETE FROM canvases WHERE workspace_id = ? AND id = ?").bind(account.id, id).run();
      return json({ ok: true });
    }
  }

  return json({ error: "not found" }, 404);
}

/**
 * Share links in R2 when it is bound. A share is written once and opened
 * straight away — usually by a room full of students the moment the link is
 * posted. On KV a read from another region within the first minute can miss,
 * and that miss is cached, so the link said "expired or does not exist" to
 * some students and worked for others. R2 has no such window. Old links that
 * were written to KV keep working through the fallback read.
 */
async function putShare(env, id, body) {
  if (env.ROOM_SCENES) return env.ROOM_SCENES.put(`share/${id}`, body);
  return env.SCENES.put(id, body);
}

async function getShare(env, id) {
  if (env.ROOM_SCENES) {
    const object = await env.ROOM_SCENES.get(`share/${id}`);
    if (object) return object.arrayBuffer();
  }
  return env.SCENES.get(id, { type: "arrayBuffer" });
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

      if (url.pathname.startsWith("/api/cloud/")) {
        try {
          return await handleCloud(request, env, url);
        } catch (error) {
          return json({ error: "cloud storage failed", detail: String(error).slice(0, 200) }, 500);
        }
      }

      const room = /^\/api\/rooms\/([A-Za-z0-9]+)\/ws$/.exec(url.pathname);
      if (room) {
        return env.ROOMS.get(env.ROOMS.idFromName(room[1])).fetch(request);
      }

      // A room's saved scene. The relay itself keeps nothing, so without this
      // a room's work vanishes the moment the last person closes the tab —
      // and pairing every room with a separate share link means two links per
      // canvas, the second frozen at the moment it was made. The body is the
      // same opaque ciphertext as a share: the key lives in the room link's
      // fragment and never reaches the Worker.
      const roomScene = /^\/api\/rooms\/([A-Za-z0-9]+)\/scene$/.exec(url.pathname);
      if (roomScene) {
        const id = roomScene[1];
        if (request.method === "PUT") {
          const length = Number(request.headers.get("content-length") ?? 0);
          if (length > MAX_BYTES) return json({ error: "too large" }, 413);
          const body = await request.arrayBuffer();
          if (body.byteLength === 0) return json({ error: "empty body" }, 400);
          if (body.byteLength > MAX_BYTES) return json({ error: "too large" }, 413);
          await putRoomScene(env, id, body);
          return json({ ok: true });
        }
        if (request.method === "GET") {
          const body = await getRoomScene(env, id);
          const store = roomStoreName(env);
          if (!body) {
            return new Response(JSON.stringify({ error: "not found" }), {
              status: 404,
              headers: { "content-type": "application/json", "x-room-store": store, ...CORS_HEADERS },
            });
          }
          return new Response(body, {
            headers: {
              "content-type": "application/octet-stream",
              // Unlike a share, this changes as the room is drawn in.
              "cache-control": "no-store",
              "x-room-store": store,
              ...CORS_HEADERS,
            },
          });
        }
      }

      if (url.pathname === "/api/scenes" && request.method === "POST") {
        const length = Number(request.headers.get("content-length") ?? 0);
        if (length > MAX_BYTES) return json({ error: "too large" }, 413);
        const body = await request.arrayBuffer();
        if (body.byteLength === 0) return json({ error: "empty body" }, 400);
        if (body.byteLength > MAX_BYTES) return json({ error: "too large" }, 413);
        const id = randomId();
        await putShare(env, id, body);
        return json({ id });
      }

      const match = /^\/api\/scenes\/([A-Za-z0-9]+)$/.exec(url.pathname);
      if (match && request.method === "GET") {
        const body = await getShare(env, match[1]);
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
