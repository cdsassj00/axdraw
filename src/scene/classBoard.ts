/**
 * Client for class boards (worker/boards.js): Padlet-style post-it walls
 * paired with canvases. Boards are plain, unencrypted and shared by link.
 *
 * What this browser remembers, in localStorage:
 * - the boards it created or opened, with the owner key for its own;
 * - the edit key of each post it wrote, so its author can remove it;
 * - the name it posts under.
 */

import { cloudFetch } from "./cloud";
import { API_BASE } from "./share";

export const BOARD_COLORS = ["yellow", "blue", "mint", "pink", "purple", "white"] as const;
export type BoardColor = (typeof BOARD_COLORS)[number];

export interface ClassBoard {
  slug: string;
  title: string;
  sections: string[];
  locked: boolean;
  createdAt: number;
}

export interface BoardFile {
  id: string;
  name: string;
  type: string;
  size: number;
}

export interface BoardComment {
  id: number;
  author: string;
  content: string;
  createdAt: number;
}

export interface BoardPost {
  id: number;
  section: string;
  author: string;
  title: string;
  content: string;
  color: BoardColor;
  link: string | null;
  file: BoardFile | null;
  likes: number;
  createdAt: number;
  comments: BoardComment[];
}

export interface KnownBoard {
  slug: string;
  title: string;
  ownerKey?: string;
  visited: number;
}

const KNOWN_KEY = "axdraw:class-boards";
const POST_KEYS = "axdraw:class-post-keys";
const AUTHOR_KEY = "axdraw:class-author";
const LIKED_KEY = "axdraw:class-liked";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the board still works, it is just forgotten.
  }
}

export const BOARD_SLUG_PATTERN = /^[A-Z0-9]{4,16}$/;

/** Boards this browser created or opened, most recent first. */
export function knownBoards(): KnownBoard[] {
  return read<KnownBoard[]>(KNOWN_KEY, []).sort((a, b) => b.visited - a.visited);
}

/**
 * Fired when this browser learns a board's owner key or a new board: the
 * list goes up to the account (inside the encrypted room-list record), so
 * the teacher is the board's owner on every device they log in on — and
 * gets that back after clearing the browser.
 */
export const CLASS_BOARDS_CHANGED = "axdraw:class-boards-changed";

export function rememberBoard(board: Pick<ClassBoard, "slug" | "title">, ownerKey?: string): void {
  const boards = read<KnownBoard[]>(KNOWN_KEY, []);
  const existing = boards.find((entry) => entry.slug === board.slug);
  let news = false;
  if (existing) {
    news = existing.title !== board.title || Boolean(ownerKey && existing.ownerKey !== ownerKey);
    existing.title = board.title;
    existing.visited = Date.now();
    if (ownerKey) existing.ownerKey = ownerKey;
  } else {
    boards.push({ slug: board.slug, title: board.title, ownerKey, visited: Date.now() });
    news = true;
  }
  write(KNOWN_KEY, boards);
  if (news) window.dispatchEvent(new Event(CLASS_BOARDS_CHANGED));
}

/** Every board this browser knows, as saved to the account. */
export function classBoardRecords(): KnownBoard[] {
  return read<KnownBoard[]>(KNOWN_KEY, []).map(({ slug, title, ownerKey, visited }) => ({ slug, title, ownerKey, visited }));
}

/** Folds in the account's list; returns whether anything new arrived. */
export function mergeClassBoardRecords(incoming: unknown): boolean {
  if (!Array.isArray(incoming)) return false;
  const boards = read<KnownBoard[]>(KNOWN_KEY, []);
  let changed = false;
  for (const raw of incoming as Partial<KnownBoard>[]) {
    if (!raw || typeof raw.slug !== "string" || !BOARD_SLUG_PATTERN.test(raw.slug)) continue;
    const existing = boards.find((entry) => entry.slug === raw.slug);
    if (!existing) {
      boards.push({ slug: raw.slug, title: String(raw.title ?? raw.slug), ownerKey: raw.ownerKey, visited: Number(raw.visited) || 0 });
      changed = true;
    } else if (raw.ownerKey && !existing.ownerKey) {
      existing.ownerKey = raw.ownerKey;
      changed = true;
    }
  }
  if (changed) write(KNOWN_KEY, boards);
  return changed;
}

/** Logging out on a shared computer must not leave a teacher's owner keys behind. */
export function clearClassBoardRecords(): void {
  try {
    localStorage.removeItem(KNOWN_KEY);
    localStorage.removeItem(POST_KEYS);
  } catch {
    // Nothing to clear.
  }
}

export function ownerKeyOf(slug: string): string | undefined {
  return read<KnownBoard[]>(KNOWN_KEY, []).find((entry) => entry.slug === slug)?.ownerKey;
}

export function postKeyOf(id: number): string | undefined {
  return read<Record<string, string>>(POST_KEYS, {})[String(id)];
}

export function authorName(): string {
  return read<string>(AUTHOR_KEY, "");
}

export function rememberAuthor(name: string): void {
  write(AUTHOR_KEY, name);
}

export function hasLiked(id: number): boolean {
  return read<number[]>(LIKED_KEY, []).includes(id);
}

export function boardLink(slug: string): string {
  return `${location.origin}${location.pathname}#board=${slug}`;
}

export function fileUrl(slug: string, file: BoardFile, download = false): string {
  return `${API_BASE}/api/boards/${slug}/files/${file.id}${download ? "?download=1" : ""}`;
}

async function call<T>(path: string, init: RequestInit = {}, slug?: string, timeoutMs = 30000): Promise<T> {
  const ownerKey = slug ? ownerKeyOf(slug) : undefined;
  const response = await cloudFetch(
    `${API_BASE}${path}`,
    {
      ...init,
      headers: {
        ...(init.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}),
        ...(ownerKey ? { "x-board-key": ownerKey } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    },
    timeoutMs,
  );
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
  return body as T;
}

export async function createClassBoard(title: string): Promise<ClassBoard> {
  const { board, ownerKey } = await call<{ board: ClassBoard; ownerKey: string }>("/api/boards", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  rememberBoard(board, ownerKey);
  return board;
}

export async function fetchClassBoard(slug: string): Promise<{ board: ClassBoard; posts: BoardPost[]; isOwner: boolean }> {
  const result = await call<{ board: ClassBoard; posts: BoardPost[]; isOwner: boolean }>(`/api/boards/${slug}`, {}, slug);
  rememberBoard(result.board);
  return result;
}

export async function updateClassBoard(
  slug: string,
  patch: Partial<Pick<ClassBoard, "title" | "sections" | "locked">>,
): Promise<ClassBoard> {
  const { board } = await call<{ board: ClassBoard }>(`/api/boards/${slug}`, { method: "PATCH", body: JSON.stringify(patch) }, slug);
  rememberBoard(board);
  return board;
}

export async function uploadBoardFile(slug: string, file: File): Promise<BoardFile> {
  const { file: stored } = await call<{ file: BoardFile }>(
    `/api/boards/${slug}/files`,
    {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
      body: file,
    },
    slug,
    60000 + Math.ceil(file.size / (1024 * 1024)) * 15000,
  );
  return stored;
}

export async function createBoardPost(
  slug: string,
  post: { author: string; section: string; title: string; content: string; color: BoardColor; link?: string; file?: BoardFile | null },
): Promise<BoardPost> {
  const { post: created, editKey } = await call<{ post: BoardPost; editKey: string }>(
    `/api/boards/${slug}/posts`,
    { method: "POST", body: JSON.stringify(post) },
    slug,
  );
  write(POST_KEYS, { ...read<Record<string, string>>(POST_KEYS, {}), [String(created.id)]: editKey });
  return created;
}

export async function deleteBoardPost(slug: string, id: number): Promise<void> {
  const editKey = postKeyOf(id);
  await call(`/api/boards/${slug}/posts/${id}`, { method: "DELETE", headers: editKey ? { "x-post-key": editKey } : {} }, slug);
}

export async function likeBoardPost(slug: string, id: number): Promise<number> {
  const { likes } = await call<{ likes: number }>(`/api/boards/${slug}/posts/${id}/like`, { method: "POST" }, slug);
  write(LIKED_KEY, [...read<number[]>(LIKED_KEY, []), id].slice(-2000));
  return likes;
}

export async function commentOnBoardPost(slug: string, id: number, author: string, content: string): Promise<void> {
  await call(`/api/boards/${slug}/posts/${id}/comments`, { method: "POST", body: JSON.stringify({ author, content }) }, slug);
}

export async function askBoardAi(slug: string, mode: "summary" | "quiz"): Promise<string> {
  const { text } = await call<{ text: string }>(`/api/boards/${slug}/ai`, { method: "POST", body: JSON.stringify({ mode }) }, slug, 90000);
  return text;
}
