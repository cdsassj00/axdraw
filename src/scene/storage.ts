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

export function deleteBoard(id: string): void {
  writeIndex(readIndex().filter((board) => board.id !== id));
  try {
    localStorage.removeItem(sceneKey(id));
  } catch {
    // Ignore.
  }
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
      elements: elements.filter((element) => !element.isDeleted),
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
