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
// Twelve was far too few: rooms past the twelfth simply fell off the list,
// and with them the only copy of their links. With the list now kept in the
// account, it can hold every room a teacher actually runs.
const MAX_ROOMS = 300;
/** Fired on window whenever the list changes, so the account copy can follow. */
export const ROOMS_CHANGED = "axdraw:rooms-changed";

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
  /** When this entry last changed — the newer side wins when lists merge. */
  updated?: number;
  /** Removed from the list. Kept as a marker so the removal reaches other devices. */
  deleted?: boolean;
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

function write(rooms: RoomMeta[], announce = true): void {
  try {
    localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms));
  } catch {
    // Quota — the running session is unaffected.
  }
  if (announce) window.dispatchEvent(new Event(ROOMS_CHANGED));
}

/** Most recently visited first. */
export function listRecentRooms(): RoomMeta[] {
  return read()
    .filter((room) => !room.deleted)
    .sort((a, b) => b.visited - a.visited);
}

/** Every entry, removal markers included — what the account copy holds. */
export function allRoomRecords(): RoomMeta[] {
  return read();
}

/**
 * Folds another device's list into this one: per room, the entry changed
 * last wins. Returns whether anything here changed.
 */
export function mergeRoomRecords(remote: readonly RoomMeta[]): boolean {
  const merged = new Map(read().map((room) => [room.id, room]));
  let changed = false;
  for (const room of remote) {
    if (!room || typeof room.id !== "string" || typeof room.key !== "string") continue;
    const local = merged.get(room.id);
    if (!local || (room.updated ?? 0) > (local.updated ?? 0)) {
      merged.set(room.id, { ...room, boardId: room.boardId ?? local?.boardId });
      changed = true;
    }
  }
  if (changed) write([...merged.values()].sort((a, b) => b.visited - a.visited).slice(0, MAX_ROOMS), false);
  return changed;
}

/** Empties the list on this device (logging out of a shared computer). */
export function clearRoomRecords(): void {
  write([], false);
}

/**
 * Records a visit. Re-entering a known room refreshes its timestamp and
 * name rather than adding a duplicate.
 */
export function rememberRoom(id: string, key: string, name: string): void {
  const previous = read().find((room) => room.id === id);
  const rooms = read().filter((room) => room.id !== id);
  rooms.unshift({ id, key, name, visited: Date.now(), boardId: previous?.boardId, updated: Date.now() });
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
    room.updated = Date.now();
    room.deleted = false;
    write(rooms);
    return;
  }
  rooms.unshift({ id, key, name: "", visited: Date.now(), boardId, updated: Date.now() });
  write(rooms.slice(0, MAX_ROOMS));
}

/** The room no longer lives in any canvas (its live sharing was stopped). */
export function unlinkRoomBoard(id: string): void {
  const rooms = read();
  const room = rooms.find((entry) => entry.id === id);
  if (!room || !room.boardId) return;
  room.boardId = undefined;
  room.updated = Date.now();
  write(rooms);
}

/** Updates the label of a room already on the list; no-op if unknown. */
export function renameRecentRoom(id: string, name: string): void {
  const rooms = read();
  const room = rooms.find((entry) => entry.id === id);
  if (!room) return;
  room.name = name;
  room.updated = Date.now();
  write(rooms);
}

export function forgetRoom(id: string): void {
  write(read().map((room) => (room.id === id ? { ...room, deleted: true, updated: Date.now() } : room)));
}

export function roomUrl(room: RoomMeta): string {
  return `${location.origin}${location.pathname}#room=${room.id},${room.key}`;
}
