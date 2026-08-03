/**
 * Undo/redo.
 *
 * Snapshots are taken at commit points (pointer-up, keyboard action, style
 * change). A cheap signature of ids+versions decides whether anything actually
 * changed, so idle interactions never pollute the stack.
 */

import type { AxElement } from "./types";

export interface HistoryEntry {
  elements: AxElement[];
  selectedIds: string[];
}

const MAX_ENTRIES = 200;

function signature(elements: readonly AxElement[]): string {
  let out = "";
  for (const element of elements) {
    out += `${element.id}:${element.version}:${element.isDeleted ? 1 : 0};`;
  }
  return out;
}

function clone(elements: readonly AxElement[]): AxElement[] {
  return structuredClone(elements as AxElement[]);
}

export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private current: HistoryEntry | null = null;
  private currentSignature = "";

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Seed the history without creating an undo step. */
  reset(elements: readonly AxElement[], selectedIds: Iterable<string>): void {
    this.undoStack = [];
    this.redoStack = [];
    this.current = { elements: clone(elements), selectedIds: [...selectedIds] };
    this.currentSignature = signature(elements);
  }

  /** Commit the current scene state as a new history step. */
  record(elements: readonly AxElement[], selectedIds: Iterable<string>): void {
    const next = signature(elements);
    if (next === this.currentSignature) {
      // Nothing structural changed; keep selection fresh for the next undo.
      if (this.current) this.current.selectedIds = [...selectedIds];
      return;
    }
    if (this.current) {
      this.undoStack.push(this.current);
      if (this.undoStack.length > MAX_ENTRIES) this.undoStack.shift();
    }
    this.redoStack = [];
    this.current = { elements: clone(elements), selectedIds: [...selectedIds] };
    this.currentSignature = next;
  }

  undo(): HistoryEntry | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    if (this.current) this.redoStack.push(this.current);
    this.current = entry;
    this.currentSignature = signature(entry.elements);
    return { elements: clone(entry.elements), selectedIds: [...entry.selectedIds] };
  }

  redo(): HistoryEntry | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    if (this.current) this.undoStack.push(this.current);
    this.current = entry;
    this.currentSignature = signature(entry.elements);
    return { elements: clone(entry.elements), selectedIds: [...entry.selectedIds] };
  }
}
