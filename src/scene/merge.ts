/**
 * Element-wise last-writer-wins: the one convergence rule every sync path
 * uses — live rooms, cloud canvases arriving from another device. Deletions
 * are tombstones (isDeleted with a newer version), so they win like any
 * other edit instead of being outvoted by an older live copy.
 */

import type { AxElement } from "../types";
import { normalizeImportedElement } from "./export";

export function isNewer(candidate: AxElement, current: AxElement): boolean {
  return (
    candidate.version > current.version ||
    (candidate.version === current.version && candidate.updated > current.updated)
  );
}

/**
 * Merges `remote` into `local`, keeping local order and appending elements
 * that are new. `onNew` sees ids that did not exist locally.
 */
export function mergeElements(
  local: readonly AxElement[],
  remote: readonly unknown[],
  onNew?: (id: string) => void,
): AxElement[] {
  const merged = new Map<string, AxElement>();
  for (const element of local) merged.set(element.id, element);
  for (const raw of remote) {
    // Whatever arrives from outside goes through the normaliser, like every
    // other way elements enter the scene.
    const element = normalizeImportedElement(raw as Record<string, unknown>);
    const existing = merged.get(element.id);
    if (!existing) onNew?.(element.id);
    if (!existing || isNewer(element, existing)) merged.set(element.id, element);
  }
  return [...merged.values()];
}

/** Cheap change detector: any edit bumps a version or changes the counts. */
export function sceneSignature(elements: readonly AxElement[], files: object): string {
  let versions = 0;
  for (const element of elements) versions += element.version;
  return `${elements.length}:${versions}:${Object.keys(files).length}`;
}
