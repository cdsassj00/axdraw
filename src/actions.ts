/** Scene-level operations shared by the toolbar, menus and keyboard. */

import { getCommonBounds, getElementBounds, isLinear } from "./element/bounds";
import { unbindArrow } from "./element/binding";
import { duplicateElement, mutateElement } from "./element/factory";
import type { AxElement, Bounds } from "./types";
import { randomId } from "./utils/random";

export interface SceneSlice {
  elements: AxElement[];
  selectedIds: Set<string>;
}

export function getSelected(elements: readonly AxElement[], selectedIds: Set<string>): AxElement[] {
  return elements.filter((element) => selectedIds.has(element.id) && !element.isDeleted);
}

/** Selecting one member of a group selects the whole group. */
export function expandSelectionToGroups(
  elements: readonly AxElement[],
  selectedIds: Set<string>,
): Set<string> {
  const groups = new Set<string>();
  for (const element of elements) {
    if (selectedIds.has(element.id)) {
      for (const groupId of element.groupIds) groups.add(groupId);
    }
  }
  if (!groups.size) return selectedIds;
  const expanded = new Set(selectedIds);
  for (const element of elements) {
    if (element.groupIds.some((groupId) => groups.has(groupId))) expanded.add(element.id);
  }
  return expanded;
}

/* ------------------------------------------------------------------ *
 * Deletion & duplication
 * ------------------------------------------------------------------ */

export function deleteSelected(slice: SceneSlice): SceneSlice {
  const doomed = new Set(slice.selectedIds);

  // Deleting a container takes its label with it; deleting a bound text frees
  // the container; deleting a shape unbinds its arrows.
  for (const element of slice.elements) {
    if (!doomed.has(element.id)) continue;
    for (const bound of element.boundElements ?? []) {
      if (bound.type === "text") doomed.add(bound.id);
    }
    if (isLinear(element)) unbindArrow(element, slice.elements);
  }

  for (const element of slice.elements) {
    if (doomed.has(element.id)) continue;
    if (element.boundElements?.some((bound) => doomed.has(bound.id))) {
      mutateElement(element, {
        boundElements: element.boundElements.filter((bound) => !doomed.has(bound.id)),
      });
    }
  }

  return {
    elements: slice.elements.filter((element) => !doomed.has(element.id)),
    selectedIds: new Set(),
  };
}

export function duplicateSelected(slice: SceneSlice, offset = { x: 10, y: 10 }): SceneSlice {
  const selected = getSelected(slice.elements, slice.selectedIds);
  if (!selected.length) return slice;

  // Groups are duplicated as new groups so the copies stay independent.
  const groupMap = new Map<string, string>();
  const copies: AxElement[] = [];
  const idMap = new Map<string, string>();

  for (const element of selected) {
    const copy = duplicateElement(element, offset);
    copy.groupIds = element.groupIds.map((groupId) => {
      if (!groupMap.has(groupId)) groupMap.set(groupId, randomId());
      return groupMap.get(groupId)!;
    });
    idMap.set(element.id, copy.id);
    copies.push(copy);
  }

  // Re-link container ↔ bound text pairs inside the copied set.
  for (let i = 0; i < selected.length; i++) {
    const source = selected[i];
    const copy = copies[i];
    if (source.boundElements?.length) {
      const bound = source.boundElements
        .filter((entry) => idMap.has(entry.id))
        .map((entry) => ({ ...entry, id: idMap.get(entry.id)! }));
      copy.boundElements = bound.length ? bound : null;
    }
    const containerId = (source as { containerId?: string | null }).containerId;
    if (containerId && idMap.has(containerId)) {
      (copy as { containerId?: string | null }).containerId = idMap.get(containerId)!;
    }
  }

  return {
    elements: [...slice.elements, ...copies],
    selectedIds: new Set(copies.map((element) => element.id)),
  };
}

/* ------------------------------------------------------------------ *
 * Z-order
 * ------------------------------------------------------------------ */

type ZAction = "front" | "back" | "forward" | "backward";

export function changeZOrder(slice: SceneSlice, action: ZAction): SceneSlice {
  const { elements, selectedIds } = slice;
  if (!selectedIds.size) return slice;
  const selected = elements.filter((element) => selectedIds.has(element.id));
  const rest = elements.filter((element) => !selectedIds.has(element.id));

  switch (action) {
    case "front":
      return { elements: [...rest, ...selected], selectedIds };
    case "back":
      return { elements: [...selected, ...rest], selectedIds };
    case "forward":
    case "backward": {
      const next = elements.slice();
      const indices = next
        .map((element, index) => (selectedIds.has(element.id) ? index : -1))
        .filter((index) => index !== -1);
      if (action === "forward") {
        for (let i = indices.length - 1; i >= 0; i--) {
          const index = indices[i];
          if (index === next.length - 1 || selectedIds.has(next[index + 1].id)) continue;
          [next[index], next[index + 1]] = [next[index + 1], next[index]];
        }
      } else {
        for (const index of indices) {
          if (index === 0 || selectedIds.has(next[index - 1].id)) continue;
          [next[index], next[index - 1]] = [next[index - 1], next[index]];
        }
      }
      return { elements: next, selectedIds };
    }
  }
}

/* ------------------------------------------------------------------ *
 * Grouping
 * ------------------------------------------------------------------ */

export function groupSelected(slice: SceneSlice): SceneSlice {
  const selected = getSelected(slice.elements, slice.selectedIds);
  if (selected.length < 2) return slice;
  const groupId = randomId();
  for (const element of selected) {
    mutateElement(element, { groupIds: [...element.groupIds, groupId] });
  }
  // Keep grouped elements contiguous and on top, like Excalidraw does.
  const rest = slice.elements.filter((element) => !slice.selectedIds.has(element.id));
  const ordered = slice.elements.filter((element) => slice.selectedIds.has(element.id));
  return { elements: [...rest, ...ordered], selectedIds: slice.selectedIds };
}

export function ungroupSelected(slice: SceneSlice): SceneSlice {
  const selected = getSelected(slice.elements, slice.selectedIds);
  const groups = new Set<string>();
  for (const element of selected) {
    const last = element.groupIds[element.groupIds.length - 1];
    if (last) groups.add(last);
  }
  if (!groups.size) return slice;
  for (const element of selected) {
    mutateElement(element, {
      groupIds: element.groupIds.filter((groupId) => !groups.has(groupId)),
    });
  }
  return slice;
}

/* ------------------------------------------------------------------ *
 * Alignment & distribution
 * ------------------------------------------------------------------ */

export type AlignDirection = "left" | "center" | "right" | "top" | "middle" | "bottom";

export function alignSelected(slice: SceneSlice, direction: AlignDirection): SceneSlice {
  const selected = getSelected(slice.elements, slice.selectedIds);
  if (selected.length < 2) return slice;
  const bounds = getCommonBounds(selected);

  for (const element of selected) {
    const b = getElementBounds(element);
    let dx = 0;
    let dy = 0;
    switch (direction) {
      case "left":
        dx = bounds.x1 - b.x1;
        break;
      case "right":
        dx = bounds.x2 - b.x2;
        break;
      case "center":
        dx = (bounds.x1 + bounds.x2) / 2 - (b.x1 + b.x2) / 2;
        break;
      case "top":
        dy = bounds.y1 - b.y1;
        break;
      case "bottom":
        dy = bounds.y2 - b.y2;
        break;
      case "middle":
        dy = (bounds.y1 + bounds.y2) / 2 - (b.y1 + b.y2) / 2;
        break;
    }
    if (dx || dy) mutateElement(element, { x: element.x + dx, y: element.y + dy });
  }
  return slice;
}

export function distributeSelected(slice: SceneSlice, axis: "horizontal" | "vertical"): SceneSlice {
  const selected = getSelected(slice.elements, slice.selectedIds);
  if (selected.length < 3) return slice;

  const measured = selected.map((element) => ({ element, bounds: getElementBounds(element) }));
  const key = axis === "horizontal" ? "x1" : "y1";
  const endKey = axis === "horizontal" ? "x2" : "y2";
  measured.sort((a, b) => a.bounds[key] - b.bounds[key]);

  const first = measured[0].bounds;
  const last = measured[measured.length - 1].bounds;
  const span = last[endKey] - first[key];
  const totalSize = measured.reduce((sum, item) => sum + (item.bounds[endKey] - item.bounds[key]), 0);
  const gap = (span - totalSize) / (measured.length - 1);

  let cursor = first[key];
  for (const item of measured) {
    const size = item.bounds[endKey] - item.bounds[key];
    const delta = cursor - item.bounds[key];
    if (delta) {
      mutateElement(item.element, {
        x: axis === "horizontal" ? item.element.x + delta : item.element.x,
        y: axis === "vertical" ? item.element.y + delta : item.element.y,
      });
    }
    cursor += size + gap;
  }
  return slice;
}

/* ------------------------------------------------------------------ *
 * Flipping & locking
 * ------------------------------------------------------------------ */

export function flipSelected(slice: SceneSlice, axis: "horizontal" | "vertical"): SceneSlice {
  const selected = getSelected(slice.elements, slice.selectedIds);
  if (!selected.length) return slice;
  const bounds: Bounds = getCommonBounds(selected);
  const cx = (bounds.x1 + bounds.x2) / 2;
  const cy = (bounds.y1 + bounds.y2) / 2;

  for (const element of selected) {
    const updates: Partial<AxElement> = {};
    if (axis === "horizontal") {
      updates.x = 2 * cx - element.x - element.width;
      updates.angle = element.angle ? -element.angle : 0;
    } else {
      updates.y = 2 * cy - element.y - element.height;
      updates.angle = element.angle ? -element.angle : 0;
    }
    if ("points" in element) {
      const points = (element as { points: [number, number][] }).points;
      (updates as { points?: [number, number][] }).points = points.map(([x, y]) =>
        axis === "horizontal"
          ? ([element.width - x, y] as [number, number])
          : ([x, element.height - y] as [number, number]),
      );
    }
    mutateElement(element, updates as never);
  }
  return slice;
}

export function setLocked(slice: SceneSlice, locked: boolean): SceneSlice {
  for (const element of getSelected(slice.elements, slice.selectedIds)) {
    mutateElement(element, { locked });
  }
  return locked ? { elements: slice.elements, selectedIds: new Set() } : slice;
}

export function unlockAll(slice: SceneSlice): SceneSlice {
  const unlocked: string[] = [];
  for (const element of slice.elements) {
    if (element.locked) {
      mutateElement(element, { locked: false });
      unlocked.push(element.id);
    }
  }
  return { elements: slice.elements, selectedIds: new Set(unlocked) };
}
