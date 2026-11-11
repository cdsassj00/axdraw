/**
 * Where canvas contents are kept in this browser.
 *
 * They used to live in localStorage, which holds about 5–10 MB for the whole
 * site. A few canvases with pictures fill that, and from then on every save
 * failed — silently. A canvas drawn after that point existed only in the
 * open tab: closing it lost the drawing, and because the canvas never made it
 * into the stored list, cloud saving skipped it too. That is how whole
 * canvases vanished.
 *
 * Contents now go to IndexedDB, which gets a share of the disk measured in
 * hundreds of megabytes or more. The rest of the app still reads and writes
 * synchronously: everything is loaded into memory once at start-up, reads
 * come from memory, and each write goes to memory at once and to IndexedDB
 * right after. Two safety nets cover the moments IndexedDB is slower than a
 * closing tab:
 *
 * - the open canvas, when small enough, is also written synchronously to a
 *   single localStorage slot (the journal) and merged back in at start-up;
 * - other tabs hear about every write over a BroadcastChannel, as they used
 *   to through localStorage's storage event.
 *
 * Without IndexedDB (some private windows) it falls back to localStorage as
 * before — but a failed write is now reported instead of swallowed.
 */

import { STORAGE_KEY } from "../constants";
import type { AxElement } from "../types";
import { mergeElements } from "./merge";

const DB_NAME = "axdraw";
const STORE = "scenes";
const JOURNAL_KEY = "axdraw:journal";
/** Larger scenes skip the journal: it must never crowd out the board list. */
const JOURNAL_MAX_CHARS = 1_500_000;
const SCENE_PREFIX = `${STORAGE_KEY}:`;

const cache = new Map<string, string>();
let db: IDBDatabase | null = null;
let ready = false;

type Listener = (key: string, value: string) => void;
const otherTabListeners: Listener[] = [];
const failureListeners: ((message: string) => void)[] = [];

const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("axdraw-scenes") : null;
if (channel) {
  channel.onmessage = (event: MessageEvent<{ key?: string; value?: string | null }>) => {
    const { key, value } = event.data ?? {};
    if (typeof key !== "string") return;
    if (typeof value === "string") {
      cache.set(key, value);
      for (const listener of otherTabListeners) listener(key, value);
    } else {
      cache.delete(key);
    }
  };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("Could not open IndexedDB"));
    open.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}

async function loadAll(database: IDBDatabase): Promise<void> {
  const tx = database.transaction(STORE, "readonly");
  const store = tx.objectStore(STORE);
  const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
  keys.forEach((key, index) => {
    const value = values[index];
    if (typeof key === "string" && typeof value === "string") cache.set(key, value);
  });
}

function putDb(key: string, value: string): Promise<void> {
  if (!db) return Promise.reject(new Error("IndexedDB unavailable"));
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(value, key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
  });
}

function deleteDb(key: string): void {
  if (!db) return;
  try {
    db.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
  } catch {
    // The memory copy is gone already; a leftover row is harmless.
  }
}

/** Two saved copies of one canvas, element by element, newest of each wins. */
function mergeSaved(a: string, b: string): string {
  try {
    const left = JSON.parse(a) as { elements?: AxElement[]; files?: object; version?: number };
    const right = JSON.parse(b) as { elements?: AxElement[]; files?: object };
    return JSON.stringify({
      ...left,
      elements: mergeElements(left.elements ?? [], right.elements ?? []),
      files: { ...(left.files ?? {}), ...(right.files ?? {}) },
    });
  } catch {
    return b.length >= a.length ? b : a;
  }
}

/** Tells the app a save could not be kept; also used for the board list. */
export function report(message: string): void {
  for (const listener of failureListeners) {
    try {
      listener(message);
    } catch {
      // A UI listener's problem is not the store's.
    }
  }
}

/**
 * Loads every saved canvas into memory and moves anything still in
 * localStorage over to IndexedDB. Must finish before the app starts.
 */
export async function initSceneStore(): Promise<void> {
  if (ready) return;
  try {
    db = await openDb();
    await loadAll(db);
  } catch {
    db = null;
  }

  // Canvases saved by earlier versions, and the journal of the last session.
  const legacy: [string, string][] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(SCENE_PREFIX)) {
        const value = localStorage.getItem(key);
        if (value) legacy.push([key, value]);
      }
    }
    const journal = localStorage.getItem(JOURNAL_KEY);
    if (journal) {
      const entry = JSON.parse(journal) as { key?: string; value?: string };
      if (typeof entry.key === "string" && typeof entry.value === "string") legacy.push([entry.key, entry.value]);
    }
  } catch {
    // Storage unavailable: nothing to move.
  }
  for (const [key, value] of legacy) {
    const existing = cache.get(key);
    const merged = existing && existing !== value ? mergeSaved(existing, value) : value;
    cache.set(key, merged);
    if (!db) continue;
    try {
      await putDb(key, merged);
      // Moved: free the space, which is what was starving every other save.
      if (key.startsWith(SCENE_PREFIX)) localStorage.removeItem(key);
    } catch {
      // Keep the localStorage copy; it is still the only safe one.
    }
  }
  if (db) {
    try {
      localStorage.removeItem(JOURNAL_KEY);
    } catch {
      // Ignore.
    }
  }
  // Ask the browser not to clear this site's data under storage pressure.
  void navigator.storage?.persist?.().catch(() => false);
  ready = true;
}

export function readScene(key: string): string | null {
  if (cache.has(key)) return cache.get(key) ?? null;
  if (db) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Saves a canvas. `open` marks the canvas on screen, whose last edits must
 * survive even a tab closed mid-write: it also goes to the journal.
 */
export function writeScene(key: string, value: string, open = false): void {
  cache.set(key, value);
  channel?.postMessage({ key, value });
  if (open && db) {
    try {
      if (value.length <= JOURNAL_MAX_CHARS) localStorage.setItem(JOURNAL_KEY, JSON.stringify({ key, value }));
      else localStorage.removeItem(JOURNAL_KEY);
    } catch {
      // Best effort only; IndexedDB below is the real copy.
    }
  }
  if (db) {
    putDb(key, value).catch(() => {
      try {
        localStorage.setItem(key, value);
      } catch {
        report("This browser could not save the canvas — storage is full");
      }
    });
    return;
  }
  try {
    localStorage.setItem(key, value);
  } catch {
    report("This browser could not save the canvas — storage is full");
  }
}

export function removeScene(key: string): void {
  cache.delete(key);
  channel?.postMessage({ key, value: null });
  deleteDb(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore.
  }
}

/** Another tab saved a canvas. */
export function onSceneFromOtherTab(listener: Listener): void {
  otherTabListeners.push(listener);
}

/** A save could not be kept anywhere in this browser. */
export function onStorageFailure(listener: (message: string) => void): void {
  failureListeners.push(listener);
}

/** Every saved canvas key — for tests and diagnostics. */
export function sceneKeys(): string[] {
  return [...cache.keys()];
}
