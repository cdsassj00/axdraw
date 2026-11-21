/**
 * Join codes: six digits that stand for a live room or a class board, so a
 * class can join from a code on the projector, a QR, or a short link
 * (axdraw.org/j/482913) instead of a long URL.
 *
 * A board is public by link anyway, so its code costs nothing. A room is
 * end-to-end encrypted by the key in its link; a code for a room stores that
 * key here, so whoever holds the code — and the server — can open the room.
 * Codes are therefore only made when someone asks for one, and the UI says
 * so. Lookups are rate-limited per IP, since a million codes could otherwise
 * be walked.
 *
 *   POST /api/codes        { kind: "room", room: { id, key } } | { kind: "board", slug }
 *                                                       → { code, expiresAt }
 *   GET  /api/codes/:code                              → { kind, room? , slug? }
 *   GET  /j/:code          → 302 to /#join=:code
 */

const CODE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOOKUPS_PER_MINUTE = 20;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS join_codes (
     code TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     target TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS join_codes_target ON join_codes (kind, target)`,
  `CREATE TABLE IF NOT EXISTS join_code_lookups (
     ip TEXT NOT NULL,
     minute INTEGER NOT NULL,
     count INTEGER NOT NULL,
     PRIMARY KEY (ip, minute)
   )`,
];

let schemaReady = null;
function ensureSchema(db) {
  schemaReady ??= db.batch(SCHEMA.map((sql) => db.prepare(sql))).catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

function randomCode() {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(value).padStart(6, "0");
}

/** The target a code stands for, normalised, or null if it is not valid. */
function targetOf(body) {
  if (body?.kind === "board" && typeof body.slug === "string" && /^[A-Z0-9]{4,16}$/.test(body.slug)) {
    return { kind: "board", target: body.slug };
  }
  const room = body?.room;
  if (
    body?.kind === "room" &&
    room &&
    typeof room.id === "string" &&
    /^[A-Za-z0-9]{4,40}$/.test(room.id) &&
    typeof room.key === "string" &&
    /^[A-Za-z0-9_-]{16,64}$/.test(room.key)
  ) {
    return { kind: "room", target: `${room.id},${room.key}` };
  }
  return null;
}

export async function handleCodes(request, env, url, { json }) {
  if (!env.DB) return json({ error: "join codes are not configured" }, 503);
  await ensureSchema(env.DB);
  const now = Date.now();

  if (url.pathname === "/api/codes" && request.method === "POST") {
    const wanted = targetOf(await request.json().catch(() => null));
    if (!wanted) return json({ error: "invalid target" }, 400);
    if (wanted.kind === "board") {
      const board = await env.DB.prepare("SELECT 1 FROM class_boards WHERE slug = ?").bind(wanted.target).first().catch(() => null);
      if (!board) return json({ error: "board not found" }, 404);
    }
    // One code per target: asking again renews it instead of minting another.
    const existing = await env.DB.prepare("SELECT code FROM join_codes WHERE kind = ? AND target = ? AND expires_at > ?")
      .bind(wanted.kind, wanted.target, now)
      .first();
    const expiresAt = now + CODE_TTL_MS;
    if (existing) {
      await env.DB.prepare("UPDATE join_codes SET expires_at = ? WHERE code = ?").bind(expiresAt, existing.code).run();
      return json({ code: existing.code, expiresAt });
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = randomCode();
      const taken = await env.DB.prepare("SELECT expires_at FROM join_codes WHERE code = ?").bind(code).first();
      if (taken && taken.expires_at > now) continue;
      await env.DB.prepare(
        `INSERT INTO join_codes (code, kind, target, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET kind = excluded.kind, target = excluded.target,
           created_at = excluded.created_at, expires_at = excluded.expires_at`,
      )
        .bind(code, wanted.kind, wanted.target, now, expiresAt)
        .run();
      return json({ code, expiresAt });
    }
    return json({ error: "could not find a free code, try again" }, 503);
  }

  const lookup = /^\/api\/codes\/(\d{6})$/.exec(url.pathname);
  if (lookup && request.method === "GET") {
    const ip = request.headers.get("cf-connecting-ip") || "local";
    const minute = Math.floor(now / 60000);
    const row = await env.DB.prepare(
      `INSERT INTO join_code_lookups (ip, minute, count) VALUES (?, ?, 1)
       ON CONFLICT(ip, minute) DO UPDATE SET count = count + 1 RETURNING count`,
    )
      .bind(ip, minute)
      .first();
    if (Math.random() < 0.02) {
      await env.DB.prepare("DELETE FROM join_code_lookups WHERE minute < ?").bind(minute - 10).run();
    }
    if ((row?.count ?? 0) > LOOKUPS_PER_MINUTE) return json({ error: "too many tries — wait a minute" }, 429);
    const found = await env.DB.prepare("SELECT kind, target, expires_at FROM join_codes WHERE code = ?").bind(lookup[1]).first();
    if (!found || found.expires_at <= now) return json({ error: "no such code" }, 404);
    if (found.kind === "board") return json({ kind: "board", slug: found.target });
    const [id, key] = String(found.target).split(",");
    return json({ kind: "room", room: { id, key } });
  }

  return json({ error: "not found" }, 404);
}
