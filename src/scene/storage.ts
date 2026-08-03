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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));

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
    const raw = localStorage.getItem(STORAGE_KEY);
    const rawState = localStorage.getItem(STORAGE_STATE_KEY);
    const state: Partial<PersistedState> = rawState ? JSON.parse(rawState) : {};
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
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore — nothing we can do if storage is unavailable.
  }
}
