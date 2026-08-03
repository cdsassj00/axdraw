/**
 * Arrow ↔ shape binding.
 *
 * A bound arrow keeps pointing at its shape while the shape moves or resizes:
 * we re-cast a ray from the arrow's neighbouring point toward the shape centre,
 * clip it against the shape outline, and keep a small gap.
 */

import { MAX_BINDING_GAP } from "../constants";
import type { AxElement, Binding, LinearElement, Point } from "../types";
import { getElementCenter, isLinear, normalizePoints, rotate } from "./bounds";
import { hitTest, isPointInPolygon } from "./hit";
import { mutateElement } from "./factory";

export function isBindableElement(element: AxElement): boolean {
  return (
    element.type === "rectangle" ||
    element.type === "diamond" ||
    element.type === "ellipse" ||
    element.type === "image" ||
    element.type === "text" ||
    element.type === "frame"
  );
}

/** Shape under the pointer that an arrow endpoint could bind to. */
export function getHoveredElementForBinding(
  point: Point,
  elements: readonly AxElement[],
  threshold: number,
  excludeId?: string,
): AxElement | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const element = elements[i];
    if (element.isDeleted || element.locked || element.id === excludeId) continue;
    if (!isBindableElement(element)) continue;
    if (hitTest(element, point, threshold) || isInsideElement(element, point)) return element;
  }
  return null;
}

export function isInsideElement(element: AxElement, point: Point): boolean {
  const center = getElementCenter(element);
  const [lx, ly] = rotate(point.x, point.y, center.x, center.y, -element.angle);
  const x = lx - element.x;
  const y = ly - element.y;
  if (element.type === "ellipse") {
    const rx = element.width / 2 || 0.0001;
    const ry = element.height / 2 || 0.0001;
    return ((x - element.width / 2) / rx) ** 2 + ((y - element.height / 2) / ry) ** 2 <= 1;
  }
  if (element.type === "diamond") {
    return isPointInPolygon(
      { x, y },
      [
        { x: element.width / 2, y: 0 },
        { x: element.width, y: element.height / 2 },
        { x: element.width / 2, y: element.height },
        { x: 0, y: element.height / 2 },
      ],
    );
  }
  return x >= 0 && x <= element.width && y >= 0 && y <= element.height;
}

/** Where a ray from `from` to the element centre crosses the element outline. */
export function getOutlineIntersection(element: AxElement, from: Point): Point {
  const center = getElementCenter(element);
  // Work in the element's local, unrotated frame.
  const [lx, ly] = rotate(from.x, from.y, center.x, center.y, -element.angle);
  const dx = lx - center.x;
  const dy = ly - center.y;
  const halfW = Math.max(element.width / 2, 0.0001);
  const halfH = Math.max(element.height / 2, 0.0001);

  let t = 1;
  if (dx === 0 && dy === 0) {
    return { x: center.x, y: center.y };
  }

  switch (element.type) {
    case "ellipse": {
      t = 1 / Math.sqrt((dx / halfW) ** 2 + (dy / halfH) ** 2);
      break;
    }
    case "diamond": {
      // |x|/a + |y|/b = 1
      t = 1 / (Math.abs(dx) / halfW + Math.abs(dy) / halfH);
      break;
    }
    default: {
      t = 1 / Math.max(Math.abs(dx) / halfW, Math.abs(dy) / halfH);
      break;
    }
  }

  const localX = center.x + dx * t;
  const localY = center.y + dy * t;
  const [x, y] = rotate(localX, localY, center.x, center.y, element.angle);
  return { x, y };
}

export function createBinding(arrow: LinearElement, shape: AxElement, endpoint: "start" | "end"): Binding {
  const points = arrow.points;
  const index = endpoint === "start" ? 0 : points.length - 1;
  const tip: Point = { x: arrow.x + points[index][0], y: arrow.y + points[index][1] };
  const intersection = getOutlineIntersection(shape, tip);
  const gap = Math.min(MAX_BINDING_GAP, Math.max(1, Math.hypot(tip.x - intersection.x, tip.y - intersection.y)));
  return { elementId: shape.id, focus: 0, gap: isInsideElement(shape, tip) ? 4 : gap };
}

export function bindArrow(
  arrow: LinearElement,
  shape: AxElement | null,
  endpoint: "start" | "end",
): void {
  if (!shape) {
    mutateElement(arrow, endpoint === "start" ? { startBinding: null } : { endBinding: null });
    return;
  }
  const binding = createBinding(arrow, shape, endpoint);
  mutateElement(arrow, endpoint === "start" ? { startBinding: binding } : { endBinding: binding });

  const bound = shape.boundElements ?? [];
  if (!bound.some((entry) => entry.id === arrow.id)) {
    mutateElement(shape, { boundElements: [...bound, { id: arrow.id, type: "arrow" }] });
  }
}

/** Recompute one bound endpoint of an arrow. */
function updateBoundPoint(
  arrow: LinearElement,
  endpoint: "start" | "end",
  elements: readonly AxElement[],
): boolean {
  const binding = endpoint === "start" ? arrow.startBinding : arrow.endBinding;
  if (!binding) return false;
  const shape = elements.find((element) => element.id === binding.elementId && !element.isDeleted);
  if (!shape) {
    mutateElement(arrow, endpoint === "start" ? { startBinding: null } : { endBinding: null });
    return false;
  }

  const points = arrow.points;
  if (points.length < 2) return false;
  const index = endpoint === "start" ? 0 : points.length - 1;
  const neighborIndex = endpoint === "start" ? 1 : points.length - 2;
  const neighbor: Point = {
    x: arrow.x + points[neighborIndex][0],
    y: arrow.y + points[neighborIndex][1],
  };

  const center = getElementCenter(shape);
  // If the neighbouring point sits inside the shape there is no sensible
  // outline crossing; leave the endpoint where the user put it.
  if (isInsideElement(shape, neighbor)) return false;

  const intersection = getOutlineIntersection(shape, neighbor);
  const dx = neighbor.x - center.x;
  const dy = neighbor.y - center.y;
  const length = Math.hypot(dx, dy) || 1;
  const gap = binding.gap ?? 4;
  const target: Point = {
    x: intersection.x + (dx / length) * gap,
    y: intersection.y + (dy / length) * gap,
  };

  const nextPoints = points.map((p) => [...p] as [number, number]);
  nextPoints[index] = [target.x - arrow.x, target.y - arrow.y];
  mutateElement(arrow, { points: nextPoints });
  normalizePoints(arrow);
  return true;
}

/** Refresh every arrow bound to any of `changed`. */
export function updateBoundArrows(
  changed: readonly AxElement[],
  elements: readonly AxElement[],
): void {
  const ids = new Set(changed.map((element) => element.id));
  const seen = new Set<string>();
  for (const element of changed) {
    for (const bound of element.boundElements ?? []) {
      if (bound.type !== "arrow" || seen.has(bound.id)) continue;
      seen.add(bound.id);
      const arrow = elements.find((candidate) => candidate.id === bound.id && !candidate.isDeleted);
      if (!arrow || !isLinear(arrow)) continue;
      // Arrows dragged together with their shapes keep their relative shape.
      if (ids.has(arrow.id)) continue;
      updateBoundPoint(arrow, "start", elements);
      updateBoundPoint(arrow, "end", elements);
    }
  }
}

/** Refresh both endpoints of the given arrows (after editing the arrow itself). */
export function refreshArrowBindings(arrows: readonly AxElement[], elements: readonly AxElement[]): void {
  for (const arrow of arrows) {
    if (!isLinear(arrow)) continue;
    updateBoundPoint(arrow, "start", elements);
    updateBoundPoint(arrow, "end", elements);
  }
}

/** Detach an arrow from shapes (used when deleting or unbinding). */
export function unbindArrow(arrow: LinearElement, elements: readonly AxElement[]): void {
  for (const binding of [arrow.startBinding, arrow.endBinding]) {
    if (!binding) continue;
    const shape = elements.find((element) => element.id === binding.elementId);
    if (shape?.boundElements) {
      mutateElement(shape, {
        boundElements: shape.boundElements.filter((entry) => entry.id !== arrow.id),
      });
    }
  }
  mutateElement(arrow, { startBinding: null, endBinding: null });
}
