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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
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
