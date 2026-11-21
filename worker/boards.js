/**
 * Class boards — a Padlet-style wall of post-its that sits beside a canvas.
 *
 * A teacher opens a board from a canvas; students open its link and post
 * notes, links and files. Boards, posts and comments live in D1; attached
 * files in R2. Unlike canvases, boards are not encrypted: they are meant to
 * be read by a whole class through a plain link.
 *
 * Who may do what:
 * - Creating a board returns an owner key, kept only in the creator's
 *   browser. With it they can rename the board, change its categories,
 *   lock it, and remove any post.
 * - Posting returns an edit key for that post: its author can remove it.
 * - Anyone with the link can read, post (unless locked), like and comment.
 * The server keeps only SHA-256 hashes of the keys.
 *
 * Uploaded files are served so they can never run as part of the site: only
 * raster images and PDFs are shown inline, everything else downloads, and
 * every response carries nosniff and a sandboxing Content-Security-Policy.
 *
 *   POST   /api/boards                          { title }        → { board, ownerKey }
 *   GET    /api/boards/:slug                                     → { board, posts, isOwner }
 *   PATCH  /api/boards/:slug          (owner)   { title?, sections?, locked? }
 *   POST   /api/boards/:slug/posts              { author, section, title, content, color, link?, file? }
 *                                                                → { post, editKey }
 *   DELETE /api/boards/:slug/posts/:id (owner or author)
 *   POST   /api/boards/:slug/posts/:id/like                      → { likes }
 *   POST   /api/boards/:slug/posts/:id/comments { author, content }
 *   POST   /api/boards/:slug/files              raw body, x-file-name → { file }
 *   GET    /api/boards/:slug/files/:id[?download=1]
 *   POST   /api/boards/:slug/ai                 { mode: "summary" | "quiz" }
 */

export const DEFAULT_SECTIONS = ["1교시", "2교시", "질문 있어요", "아이디어 · 피드백"];
const COLORS = ["yellow", "blue", "mint", "pink", "purple", "white"];
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS class_boards (
     slug TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     sections_json TEXT NOT NULL,
     locked INTEGER NOT NULL DEFAULT 0,
     owner_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS class_posts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     board_slug TEXT NOT NULL,
     section TEXT NOT NULL,
     author TEXT NOT NULL,
     title TEXT NOT NULL,
     content TEXT NOT NULL,
     color TEXT NOT NULL,
     link_url TEXT,
     file_key TEXT,
     file_name TEXT,
     file_type TEXT,
     file_size INTEGER,
     likes INTEGER NOT NULL DEFAULT 0,
     edit_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS class_posts_board ON class_posts (board_slug, id)`,
  `CREATE TABLE IF NOT EXISTS class_comments (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     post_id INTEGER NOT NULL,
     board_slug TEXT NOT NULL,
     author TEXT NOT NULL,
     content TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS class_comments_board ON class_comments (board_slug, post_id)`,
];

let schemaReady = null;
function ensureSchema(db) {
  schemaReady ??= db.batch(SCHEMA.map((sql) => db.prepare(sql))).catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

const SLUG_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function randomSlug() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => SLUG_ALPHABET[byte % SLUG_ALPHABET.length]).join("");
}

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameHash(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function text(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** An http(s) link, or "" — never javascript:, data: or anything else. */
function safeLink(value) {
  let raw = text(value, 2000);
  if (!raw) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function cleanSections(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const sections = [];
  for (const item of value) {
    const name = text(item, 60);
    if (name && !seen.has(name)) {
      seen.add(name);
      sections.push(name);
    }
  }
  return sections.length && sections.length <= 30 ? sections : null;
}

function boardView(row) {
  let sections = DEFAULT_SECTIONS;
  try {
    const parsed = JSON.parse(row.sections_json);
    if (Array.isArray(parsed) && parsed.length) sections = parsed;
  } catch {
    // Keep the defaults.
  }
  return { slug: row.slug, title: row.title, sections, locked: Boolean(row.locked), createdAt: row.created_at };
}

function postView(row, comments = []) {
  return {
    id: row.id,
    section: row.section,
    author: row.author,
    title: row.title,
    content: row.content,
    color: row.color,
    link: row.link_url || null,
    file: row.file_key
      ? { id: row.file_key.slice(row.file_key.lastIndexOf("/") + 1), name: row.file_name, type: row.file_type, size: row.file_size }
      : null,
    likes: row.likes,
    createdAt: row.created_at,
    comments,
  };
}

async function isOwner(request, board) {
  const key = request.headers.get("x-board-key");
  return Boolean(key) && sameHash(board.owner_hash, await sha256Hex(key));
}

function fileKey(slug, id) {
  return `boardfile/${slug}/${id}`;
}

/** A filename safe to echo back in a header and on screen. */
function cleanFileName(value) {
  let name = "";
  try {
    name = decodeURIComponent(value || "");
  } catch {
    name = value || "";
  }
  return name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().slice(0, 200) || "file";
}

/**
 * Asks the configured AI provider for a summary or quiz of a board.
 * `ai` is { base, key, model } from the Worker's provider resolution.
 */
async function boardAi(ai, mode, board, posts) {
  const lines = posts
    .slice(0, 60)
    .map((post) => `- [${post.section}] ${post.title}${post.content ? `: ${post.content.slice(0, 400)}` : ""}${post.link_url ? ` (${post.link_url})` : ""}`)
    .join("\n");
  const instruction =
    mode === "quiz"
      ? "Write a short quiz (5 questions, each with 4 options and the answer marked) that checks understanding of what this class board covers."
      : "Summarise this class board for the teacher: the main themes, what students asked, and any ideas worth following up. Group by category.";
  const response = await fetch(`${ai.base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${ai.key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: ai.model,
      temperature: 0.4,
      max_tokens: 1500,
      messages: [
        {
          role: "system",
          content:
            "You help a teacher with a class post-it board. Answer in the language the posts are written in " +
            "(Korean if they are Korean). Plain text only: short lines, no markdown headings or code fences.",
        },
        { role: "user", content: `${instruction}\n\nBoard: ${board.title}\nPosts:\n${lines || "(no posts yet)"}` },
      ],
    }),
  });
  if (!response.ok) throw new Error(`AI request failed (${response.status})`);
  const data = await response.json();
  return String(data?.choices?.[0]?.message?.content ?? "").trim();
}

/**
 * Handles every /api/boards… request. `deps` carries the Worker's json()
 * helper, CORS headers, and a function that resolves the AI provider.
 */
export async function handleBoards(request, env, url, deps) {
  const { json, cors, resolveAi } = deps;
  if (!env.DB) return json({ error: "boards are not configured" }, 503);
  await ensureSchema(env.DB);
  const now = Date.now();
  const method = request.method;

  if (url.pathname === "/api/boards" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const title = text(body.title, 120) || "강의 게시판";
    const ownerKey = randomKey();
    const ownerHash = await sha256Hex(ownerKey);
    let slug = randomSlug();
    for (let tries = 0; tries < 3; tries++) {
      const taken = await env.DB.prepare("SELECT 1 FROM class_boards WHERE slug = ?").bind(slug).first();
      if (!taken) break;
      slug = randomSlug();
    }
    await env.DB.prepare(
      "INSERT INTO class_boards (slug, title, sections_json, locked, owner_hash, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
    )
      .bind(slug, title, JSON.stringify(DEFAULT_SECTIONS), ownerHash, now, now)
      .run();
    return json({ board: { slug, title, sections: DEFAULT_SECTIONS, locked: false, createdAt: now }, ownerKey });
  }

  const match = /^\/api\/boards\/([A-Z0-9]{4,16})(\/.*)?$/.exec(url.pathname);
  if (!match) return json({ error: "not found" }, 404);
  const slug = match[1];
  const rest = match[2] ?? "";
  const board = await env.DB.prepare("SELECT * FROM class_boards WHERE slug = ?").bind(slug).first();
  if (!board) return json({ error: "board not found" }, 404);

  if (rest === "" && method === "GET") {
    const [posts, comments] = await Promise.all([
      env.DB.prepare("SELECT * FROM class_posts WHERE board_slug = ? ORDER BY id DESC LIMIT 500").bind(slug).all(),
      env.DB.prepare("SELECT id, post_id, author, content, created_at FROM class_comments WHERE board_slug = ? ORDER BY id ASC LIMIT 2000")
        .bind(slug)
        .all(),
    ]);
    const byPost = new Map();
    for (const comment of comments.results ?? []) {
      const list = byPost.get(comment.post_id) ?? [];
      list.push({ id: comment.id, author: comment.author, content: comment.content, createdAt: comment.created_at });
      byPost.set(comment.post_id, list);
    }
    return json({
      board: boardView(board),
      posts: (posts.results ?? []).map((row) => postView(row, byPost.get(row.id) ?? [])),
      isOwner: await isOwner(request, board),
    });
  }

  if (rest === "" && method === "PATCH") {
    if (!(await isOwner(request, board))) return json({ error: "only the board's owner can change it" }, 403);
    const body = await request.json().catch(() => ({}));
    const title = body.title === undefined ? board.title : text(body.title, 120) || board.title;
    const sections = body.sections === undefined ? null : cleanSections(body.sections);
    if (body.sections !== undefined && !sections) return json({ error: "invalid categories" }, 400);
    const locked = body.locked === undefined ? board.locked : body.locked ? 1 : 0;
    await env.DB.prepare("UPDATE class_boards SET title = ?, sections_json = ?, locked = ?, updated_at = ? WHERE slug = ?")
      .bind(title, sections ? JSON.stringify(sections) : board.sections_json, locked, now, slug)
      .run();
    const updated = await env.DB.prepare("SELECT * FROM class_boards WHERE slug = ?").bind(slug).first();
    return json({ board: boardView(updated) });
  }

  if (rest === "/files" && method === "POST") {
    if (!env.ROOM_SCENES) return json({ error: "file storage is not configured" }, 503);
    if (board.locked && !(await isOwner(request, board))) return json({ error: "this board is locked" }, 403);
    const length = Number(request.headers.get("content-length") ?? 0);
    if (!length) return json({ error: "empty file" }, 400);
    if (length > MAX_FILE_BYTES) return json({ error: "file too large" }, 413);
    const name = cleanFileName(request.headers.get("x-file-name"));
    const type = (request.headers.get("content-type") || "application/octet-stream").split(";")[0].trim().slice(0, 100);
    const id = randomKey().slice(0, 16);
    const fixed = new FixedLengthStream(length);
    request.body.pipeTo(fixed.writable).catch(() => undefined);
    await env.ROOM_SCENES.put(fileKey(slug, id), fixed.readable, {
      httpMetadata: { contentType: type },
      customMetadata: { filename: name },
    });
    return json({ file: { id, name, type, size: length } });
  }

  const fileMatch = /^\/files\/([A-Za-z0-9_-]{8,32})$/.exec(rest);
  if (fileMatch && method === "GET") {
    if (!env.ROOM_SCENES) return json({ error: "file storage is not configured" }, 503);
    const object = await env.ROOM_SCENES.get(fileKey(slug, fileMatch[1]));
    if (!object) return json({ error: "not found" }, 404);
    const type = object.httpMetadata?.contentType || "application/octet-stream";
    const name = object.customMetadata?.filename || "file";
    const inline = INLINE_TYPES.has(type) && url.searchParams.get("download") !== "1";
    return new Response(object.body, {
      headers: {
        // Anything that is not a plain image or PDF is served as a download
        // of an opaque type, so an uploaded page or script can never run
        // under axdraw.org.
        "content-type": inline ? type : "application/octet-stream",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
        "cache-control": "private, max-age=3600",
        ...cors,
      },
    });
  }

  if (rest === "/posts" && method === "POST") {
    const owner = await isOwner(request, board);
    if (board.locked && !owner) return json({ error: "this board is locked" }, 403);
    const body = await request.json().catch(() => ({}));
    const sections = boardView(board).sections;
    const section = sections.includes(text(body.section, 60)) ? text(body.section, 60) : sections[0];
    const link = safeLink(body.link);
    let file = null;
    if (body.file && typeof body.file.id === "string" && /^[A-Za-z0-9_-]{8,32}$/.test(body.file.id) && env.ROOM_SCENES) {
      // Trust the stored object, not what the browser says about it.
      const head = await env.ROOM_SCENES.head(fileKey(slug, body.file.id));
      if (head) {
        file = {
          key: fileKey(slug, body.file.id),
          name: head.customMetadata?.filename || "file",
          type: head.httpMetadata?.contentType || "application/octet-stream",
          size: head.size,
        };
      }
    }
    const title = text(body.title, 200) || file?.name || (link ? new URL(link).hostname : "");
    const content = text(body.content, 5000);
    if (!title && !content) return json({ error: "a post needs a title, text, a link or a file" }, 400);
    const author = text(body.author, 40) || "익명";
    const color = COLORS.includes(body.color) ? body.color : "yellow";
    const editKey = randomKey();
    const inserted = await env.DB.prepare(
      `INSERT INTO class_posts (board_slug, section, author, title, content, color, link_url, file_key, file_name, file_type, file_size, edit_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(slug, section, author, title, content, color, link || null, file?.key ?? null, file?.name ?? null, file?.type ?? null, file?.size ?? null, await sha256Hex(editKey), now)
      .run();
    const row = await env.DB.prepare("SELECT * FROM class_posts WHERE id = ?").bind(inserted.meta.last_row_id).first();
    return json({ post: postView(row), editKey });
  }

  const postMatch = /^\/posts\/(\d+)(\/like|\/comments)?$/.exec(rest);
  if (postMatch) {
    const id = Number(postMatch[1]);
    const post = await env.DB.prepare("SELECT * FROM class_posts WHERE id = ? AND board_slug = ?").bind(id, slug).first();
    if (!post) return json({ error: "post not found" }, 404);

    if (!postMatch[2] && method === "DELETE") {
      const editKey = request.headers.get("x-post-key");
      const author = Boolean(editKey) && sameHash(post.edit_hash, await sha256Hex(editKey));
      if (!author && !(await isOwner(request, board))) return json({ error: "only its author or the board's owner can remove a post" }, 403);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM class_comments WHERE post_id = ?").bind(id),
        env.DB.prepare("DELETE FROM class_posts WHERE id = ?").bind(id),
      ]);
      if (post.file_key && env.ROOM_SCENES) await env.ROOM_SCENES.delete(post.file_key).catch(() => undefined);
      return json({ ok: true });
    }

    if (postMatch[2] === "/like" && method === "POST") {
      await env.DB.prepare("UPDATE class_posts SET likes = likes + 1 WHERE id = ?").bind(id).run();
      return json({ likes: post.likes + 1 });
    }

    if (postMatch[2] === "/comments" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const content = text(body.content, 1000);
      if (!content) return json({ error: "empty comment" }, 400);
      const author = text(body.author, 40) || "익명";
      await env.DB.prepare("INSERT INTO class_comments (post_id, board_slug, author, content, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, slug, author, content, now)
        .run();
      return json({ ok: true });
    }
  }

  if (rest === "/ai" && method === "POST") {
    const ai = await resolveAi(request);
    if (!ai) return json({ error: "AI is not configured" }, 501);
    if (!ai.model) return json({ error: "no usable AI model found" }, 502);
    const body = await request.json().catch(() => ({}));
    const mode = body.mode === "quiz" ? "quiz" : "summary";
    const posts = await env.DB.prepare("SELECT section, title, content, link_url FROM class_posts WHERE board_slug = ? ORDER BY id DESC LIMIT 60")
      .bind(slug)
      .all();
    try {
      return json({ text: await boardAi(ai, mode, board, posts.results ?? []) });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  }

  return json({ error: "not found" }, 404);
}
