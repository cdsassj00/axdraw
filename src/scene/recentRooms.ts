/**
 * Recently visited collaboration rooms.
 *
 * A room is a relay, not storage: the Worker keeps nothing, so a room link
 * that falls out of the browser's address bar is gone for good — its
 * decryption key lives only in the URL fragment. This keeps a short local
 * list so a room can be reopened without hunting through history.
 *
 * The key is stored alongside the id, because a room id alone cannot open
 * anything. That is the same secret the URL already carries, held in
 * same-origin localStorage and never sent anywhere.
 */

const ROOMS_KEY = "axdraw:rooms";
const MAX_ROOMS = 12;

export interface RoomMeta {
  id: string;
  /** base64url AES key — useless without it, so it travels with the id. */
  key: string;
  /** Board name at the time of the visit; a label, not an identifier. */
  name: string;
  visited: number;
  /**
   * The board this room's scene lives in. A room gets its own board so that
   * joining never mixes the room with whatever the user was drawing before,
   * and so that rejoining the same room returns to the same canvas.
   */
  boardId?: string;
}

function read(): RoomMeta[] {
  try {
    const raw = localStorage.getItem(ROOMS_KEY);
    const parsed = raw ? (JSON.parse(raw) as RoomMeta[]) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((room) => room && typeof room.id === "string" && typeof room.key === "string");
  } catch {
    return [];
  }
}

function write(rooms: RoomMeta[]): void {
  try {
    localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms));
  } catch {
    // Quota — the running session is unaffected.
  }
}

/** Most recently visited first. */
export function listRecentRooms(): RoomMeta[] {
  return read().sort((a, b) => b.visited - a.visited);
}

/**
 * Records a visit. Re-entering a known room refreshes its timestamp and
 * name rather than adding a duplicate.
 */
export function rememberRoom(id: string, key: string, name: string): void {
  const previous = read().find((room) => room.id === id);
  const rooms = read().filter((room) => room.id !== id);
  rooms.unshift({ id, key, name, visited: Date.now(), boardId: previous?.boardId });
  write(rooms.slice(0, MAX_ROOMS));
}

/** The board a room's scene lives in, if this browser has been in it before. */
export function roomBoardId(id: string): string | undefined {
  return read().find((room) => room.id === id)?.boardId;
}

/** Ties a room to the board holding its scene. */
export function setRoomBoard(id: string, key: string, boardId: string): void {
  const rooms = read();
  const room = rooms.find((entry) => entry.id === id);
  if (room) {
    room.boardId = boardId;
    write(rooms);
    return;
  }
  rooms.unshift({ id, key, name: "", visited: Date.now(), boardId });
  write(rooms.slice(0, MAX_ROOMS));
}

/** Updates the label of a room already on the list; no-op if unknown. */
export function renameRecentRoom(id: string, name: string): void {
  const rooms = read();
  const room = rooms.find((entry) => entry.id === id);
  if (!room) return;
  room.name = name;
  write(rooms);
}

export function forgetRoom(id: string): void {
  write(read().filter((room) => room.id !== id));
}

export function roomUrl(room: RoomMeta): string {
  return `${location.origin}${location.pathname}#room=${room.id},${room.key}`;
}
