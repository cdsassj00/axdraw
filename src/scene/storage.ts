/** Local persistence — the scene survives a reload without any server. */

import { DEFAULT_STYLE, SCENE_VERSION, STORAGE_KEY, STORAGE_STATE_KEY } from "../constants";
import type { AppState, AxElement, BinaryFiles, ItemStyle } from "../types";

interface PersistedState {
  scrollX: number;
  scrollY: number;
  zoom: number;
  theme: AppState["theme"];
  viewBackgroundColor: string;
  gridEnabled: boolean;
  gridSize: number;
  snapEnabled: boolean;
  shapeRecognition: boolean;
  /**
   * Shape assist, persisted under a new name: the old `shapeRecognition`
   * field dates from when assist defaulted ON, so every existing browser
   * has `true` stored without the user ever choosing it. Ignoring the old
   * field applies the new off-by-default once; toggles persist here.
   */
  shapeAssist?: boolean;
  toolLocked: boolean;
  statsEnabled: boolean;
  zenMode: boolean;
  viewMode: boolean;
  currentStyle: ItemStyle;
}

export interface LoadedScene {
  elements: AxElement[];
  files: BinaryFiles;
  state: Partial<PersistedState>;
}

/* ---------------------------------------------------------------- *
 * Boards — multiple canvases in one browser.
 *
 * Each board's scene lives under its own key; a small index carries names
 * and timestamps. The pre-boards scene (bare STORAGE_KEY) is adopted as the
 * first board on first touch, so nobody loses their drawing to the upgrade.
 * ---------------------------------------------------------------- */

const BOARDS_KEY = "axdraw:boards";
const CURRENT_BOARD_KEY = "axdraw:board-current";

export interface BoardMeta {
  id: string;
  name: string;
  updated: number;
  /**
   * The live room this canvas is shared through, if any. Kept on the board
   * itself so a canvas and its collaboration link are one thing: opening the
   * canvas reconnects to its room, and the link never drifts to another board.
   */
  room?: { id: string; key: string };
  /** The share link this canvas was opened from, so opening it twice reuses it. */
  shareId?: string;
  /** Server version of the last cloud save or load this copy is built on. */
  cloudSynced?: number;
  /** Listed in the cloud but not yet downloaded to this browser. */
  remote?: boolean;
}

function sceneKey(boardId: string): string {
  return `${STORAGE_KEY}:${boardId}`;
}

function readIndex(): BoardMeta[] {
  try {
    const raw = localStorage.getItem(BOARDS_KEY);
    const parsed = raw ? (JSON.parse(raw) as BoardMeta[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeIndex(boards: BoardMeta[]): void {
  try {
    localStorage.setItem(BOARDS_KEY, JSON.stringify(boards));
  } catch {
    // Quota — boards keep working in memory.
  }
}

export function listBoards(): BoardMeta[] {
  return readIndex().sort((a, b) => b.updated - a.updated);
}

/** The active board id, migrating the legacy single scene on first call. */
export function currentBoardId(): string {
  let boards = readIndex();
  if (!boards.length) {
    const id = Math.random().toString(36).slice(2, 10);
    boards = [{ id, name: "캔버스 1", updated: Date.now() }];
    writeIndex(boards);
    try {
      const legacy = localStorage.getItem(STORAGE_KEY);
      if (legacy) {
        localStorage.setItem(sceneKey(id), legacy);
        localStorage.removeItem(STORAGE_KEY);
      }
      localStorage.setItem(CURRENT_BOARD_KEY, id);
    } catch {
      // Storage unavailable — stay in memory.
    }
    return id;
  }
  const stored = localStorage.getItem(CURRENT_BOARD_KEY);
  if (stored && boards.some((board) => board.id === stored)) return stored;
  const fallback = boards[0].id;
  try {
    localStorage.setItem(CURRENT_BOARD_KEY, fallback);
  } catch {
    // Ignore.
  }
  return fallback;
}

export function setCurrentBoard(id: string): void {
  try {
    localStorage.setItem(CURRENT_BOARD_KEY, id);
  } catch {
    // Ignore.
  }
}

export function createBoard(): BoardMeta {
  const boards = readIndex();
  const numbers = boards
    .map((board) => /^캔버스 (\d+)$/.exec(board.name)?.[1])
    .filter(Boolean)
    .map(Number);
  const board: BoardMeta = {
    id: Math.random().toString(36).slice(2, 10),
    name: `캔버스 ${Math.max(0, ...numbers) + 1}`,
    updated: Date.now(),
  };
  writeIndex([...boards, board]);
  return board;
}

/**
 * Appends elements to a board that is not open.
 *
 * Splitting a crowded canvas means taking a slice of it somewhere else, and
 * loading the target board just to add to it would throw away whatever is on
 * screen. Coordinates are kept exactly as they are so a cluster lands in the
 * same relative arrangement it had.
 */
export function appendToBoard(
  boardId: string,
  elements: readonly AxElement[],
  files: BinaryFiles,
): void {
  try {
    const raw = localStorage.getItem(sceneKey(boardId));
    const existing = raw
      ? (JSON.parse(raw) as { elements?: AxElement[]; files?: BinaryFiles })
      : { elements: [], files: {} };
    const payload = {
      version: SCENE_VERSION,
      elements: [...(existing.elements ?? []), ...elements.filter((element) => !element.isDeleted)],
      files: { ...(existing.files ?? {}), ...files },
    };
    localStorage.setItem(sceneKey(boardId), JSON.stringify(payload));
    touchBoard(boardId);
  } catch {
    // Quota or unavailable storage — the caller reports the failure.
    throw new Error("Could not write to that canvas");
  }
}

/** Removes elements from a board that is not open — undo of appendToBoard. */
export function removeFromBoard(boardId: string, ids: readonly string[]): void {
  try {
    const raw = localStorage.getItem(sceneKey(boardId));
    if (!raw) return;
    const parsed = JSON.parse(raw) as { elements?: AxElement[]; files?: BinaryFiles };
    const drop = new Set(ids);
    localStorage.setItem(
      sceneKey(boardId),
      JSON.stringify({
        version: SCENE_VERSION,
        elements: (parsed.elements ?? []).filter((element) => !drop.has(element.id)),
        files: parsed.files ?? {},
      }),
    );
  } catch {
    // Nothing safe to do; the caller cannot recover either.
  }
}

export function deleteBoard(id: string): void {
  writeIndex(readIndex().filter((board) => board.id !== id));
  try {
    localStorage.removeItem(sceneKey(id));
  } catch {
    // Ignore.
  }
}

/** Attaches (or with `undefined`, detaches) a room or share link to a board. */
export function setBoardLink(
  id: string,
  link: Partial<Pick<BoardMeta, "room" | "shareId" | "cloudSynced" | "remote">>,
): void {
  writeIndex(readIndex().map((board) => (board.id === id ? { ...board, ...link } : board)));
}

/** Adds a board known from elsewhere (the cloud) without opening it. */
export function addBoard(board: BoardMeta): void {
  const boards = readIndex();
  if (boards.some((entry) => entry.id === board.id)) return;
  writeIndex([...boards, board]);
}

/** Scene of a board that may not be open. */
export function readBoardScene(boardId: string): { elements: AxElement[]; files: BinaryFiles } {
  try {
    const raw = localStorage.getItem(sceneKey(boardId));
    const parsed = raw ? (JSON.parse(raw) as { elements?: AxElement[]; files?: BinaryFiles }) : {};
    return { elements: Array.isArray(parsed.elements) ? parsed.elements : [], files: parsed.files ?? {} };
  } catch {
    return { elements: [], files: {} };
  }
}

/** Writes the scene of a board that is not open. */
export function writeBoardScene(boardId: string, elements: readonly AxElement[], files: BinaryFiles): void {
  try {
    localStorage.setItem(
      sceneKey(boardId),
      JSON.stringify({ version: SCENE_VERSION, elements: keepable(elements), files }),
    );
  } catch {
    // Quota — the cloud copy is still there.
  }
}

/**
 * What a saved scene keeps: every live element, and deletions from the last
 * month. Deletions used to be dropped on save, so after a reload nothing
 * remembered that a shape had been erased — and an older copy arriving from
 * a room or another device brought it straight back. A month covers any
 * realistic gap between devices without letting tombstones pile up forever.
 */
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
function keepable(elements: readonly AxElement[]): AxElement[] {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  return elements.filter((element) => !element.isDeleted || element.updated > cutoff);
}

export function findBoardByRoom(roomId: string): BoardMeta | undefined {
  return readIndex().find((board) => board.room?.id === roomId);
}

export function findBoardByShare(shareId: string): BoardMeta | undefined {
  return readIndex().find((board) => board.shareId === shareId);
}

export function getBoard(id: string): BoardMeta | undefined {
  return readIndex().find((board) => board.id === id);
}

export function renameBoard(id: string, name: string): void {
  writeIndex(readIndex().map((board) => (board.id === id ? { ...board, name } : board)));
}

function touchBoard(id: string): void {
  writeIndex(readIndex().map((board) => (board.id === id ? { ...board, updated: Date.now() } : board)));
}

export function saveScene(
  elements: readonly AxElement[],
  files: BinaryFiles,
  state: AppState,
): void {
  try {
    const payload = {
      version: SCENE_VERSION,
      elements: keepable(elements),
      files,
    };
    localStorage.setItem(sceneKey(currentBoardId()), JSON.stringify(payload));
    touchBoard(currentBoardId());

    const persisted: PersistedState = {
      scrollX: state.scrollX,
      scrollY: state.scrollY,
      zoom: state.zoom,
      theme: state.theme,
      viewBackgroundColor: state.viewBackgroundColor,
      gridEnabled: state.gridEnabled,
      gridSize: state.gridSize,
      snapEnabled: state.snapEnabled,
      shapeRecognition: state.shapeRecognition,
      shapeAssist: state.shapeRecognition,
      toolLocked: state.toolLocked,
      statsEnabled: state.statsEnabled,
      zenMode: state.zenMode,
      viewMode: state.viewMode,
      currentStyle: state.currentStyle,
    };
    localStorage.setItem(STORAGE_STATE_KEY, JSON.stringify(persisted));
  } catch {
    // Quota exceeded (usually large pasted images) — keep working in memory.
  }
}

export function loadScene(): LoadedScene | null {
  try {
    const raw = localStorage.getItem(sceneKey(currentBoardId()));
    const rawState = localStorage.getItem(STORAGE_STATE_KEY);
    const state: Partial<PersistedState> = rawState ? JSON.parse(rawState) : {};
    // Migration: only the new field carries the user's actual choice.
    const assist = state.shapeAssist;
    delete state.shapeAssist;
    delete state.shapeRecognition;
    if (assist !== undefined) state.shapeRecognition = assist;
    if (state.currentStyle) {
      state.currentStyle = { ...DEFAULT_STYLE, ...state.currentStyle };
    }
    if (!raw) return { elements: [], files: {}, state };
    const parsed = JSON.parse(raw) as { elements?: AxElement[]; files?: BinaryFiles };
    return {
      elements: Array.isArray(parsed.elements) ? parsed.elements : [],
      files: parsed.files ?? {},
      state,
    };
  } catch {
    return null;
  }
}

export function clearStoredScene(): void {
  try {
    localStorage.removeItem(sceneKey(currentBoardId()));
  } catch {
    // Ignore — nothing we can do if storage is unavailable.
  }
}
