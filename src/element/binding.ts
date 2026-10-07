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

/** Arrows within this angle of an axis are treated as meant to be straight. */
const STRAIGHT_TOLERANCE = Math.tan((20 * Math.PI) / 180);

interface Span {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Axis-aligned extent of an unrotated shape; null when it is rotated. */
function spanOf(shape: AxElement): Span | null {
  if (shape.angle) return null;
  return {
    left: shape.x,
    right: shape.x + shape.width,
    top: shape.y,
    bottom: shape.y + shape.height,
  };
}

/**
 * Where a horizontal (axis "x") or vertical (axis "y") line at `at` meets the
 * outline on the side facing `toward`. Null when the line misses the shape.
 */
function facingPoint(shape: AxElement, axis: "x" | "y", at: number, toward: number): Point | null {
  const center = getElementCenter(shape);
  const half = axis === "x" ? shape.width / 2 : shape.height / 2;
  const across = axis === "x" ? shape.height / 2 : shape.width / 2;
  const offset = Math.abs(at - (axis === "x" ? center.y : center.x));
  if (across <= 0 || offset > across) return null;
  let reach = half;
  if (shape.type === "ellipse") reach = half * Math.sqrt(Math.max(0, 1 - (offset / across) ** 2));
  else if (shape.type === "diamond") reach = half * (1 - offset / across);
  const sign = toward >= (axis === "x" ? center.x : center.y) ? 1 : -1;
  return axis === "x"
    ? { x: center.x + sign * reach, y: at }
    : { x: at, y: center.y + sign * reach };
}

/** Which axis a segment is meant to follow, if it is close enough to one. */
function intendedAxis(from: Point, to: Point): "x" | "y" | null {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  if (dx === 0 && dy === 0) return null;
  if (dy <= dx * STRAIGHT_TOLERANCE) return "x";
  if (dx <= dy * STRAIGHT_TOLERANCE) return "y";
  return null;
}

function setPoint(arrow: LinearElement, index: number, point: Point): void {
  const nextPoints = arrow.points.map((p) => [...p] as [number, number]);
  nextPoints[index] = [point.x - arrow.x, point.y - arrow.y];
  mutateElement(arrow, { points: nextPoints });
}

function pointAt(arrow: LinearElement, index: number): Point {
  return { x: arrow.x + arrow.points[index][0], y: arrow.y + arrow.points[index][1] };
}

/**
 * Keeps a straight arrow straight.
 *
 * Binding used to re-aim each end at the shape's centre. Two boxes whose
 * centres are a few pixels apart vertically then turned every carefully
 * straight arrow between them into a slight diagonal — the moment it attached,
 * and again whenever either box moved. Instead, when the arrow runs close to an
 * axis and a line along that axis can reach the shape, the end stays on that
 * line and only slides to the outline.
 */
function straightenSegment(
  arrow: LinearElement,
  endpoint: "start" | "end",
  shape: AxElement,
  gap: number,
): boolean {
  const span = spanOf(shape);
  if (!span) return false;
  const index = endpoint === "start" ? 0 : arrow.points.length - 1;
  const neighbor = pointAt(arrow, endpoint === "start" ? 1 : arrow.points.length - 2);
  const axis = intendedAxis(neighbor, pointAt(arrow, index));
  if (!axis) return false;
  const at = axis === "x" ? neighbor.y : neighbor.x;
  // The neighbour must sit beside the shape, not over it, for the line to land on a side.
  if (axis === "x" && neighbor.x >= span.left && neighbor.x <= span.right) return false;
  if (axis === "y" && neighbor.y >= span.top && neighbor.y <= span.bottom) return false;
  const hit = facingPoint(shape, axis, at, axis === "x" ? neighbor.x : neighbor.y);
  if (!hit) return false;
  const sign = axis === "x" ? Math.sign(neighbor.x - hit.x) : Math.sign(neighbor.y - hit.y);
  setPoint(
    arrow,
    index,
    axis === "x" ? { x: hit.x + sign * gap, y: hit.y } : { x: hit.x, y: hit.y + sign * gap },
  );
  return true;
}

/**
 * A two-point arrow tied to a shape at each end: find a single line along the
 * arrow's axis that crosses both, staying as close to where it was as the
 * shapes allow. Moving one box a little keeps the arrow level instead of
 * tilting it; only once the boxes no longer overlap along that axis does the
 * arrow have to go diagonal.
 */
function straightenBetween(arrow: LinearElement, elements: readonly AxElement[]): boolean {
  if (arrow.points.length !== 2 || !arrow.startBinding || !arrow.endBinding) return false;
  const find = (id: string) => elements.find((element) => element.id === id && !element.isDeleted);
  const from = find(arrow.startBinding.elementId);
  const to = find(arrow.endBinding.elementId);
  if (!from || !to) return false;
  const a = spanOf(from);
  const b = spanOf(to);
  if (!a || !b) return false;
  const start = pointAt(arrow, 0);
  const end = pointAt(arrow, 1);
  const axis = intendedAxis(start, end);
  if (!axis) return false;

  const [lowA, highA, lowB, highB] =
    axis === "x" ? [a.top, a.bottom, b.top, b.bottom] : [a.left, a.right, b.left, b.right];
  const low = Math.max(lowA, lowB);
  const high = Math.min(highA, highB);
  if (high < low) return false;
  // Stay off the very corners, where a curved or pointed outline has no side.
  const inset = Math.min(8, (high - low) / 2);
  const current = axis === "x" ? start.y : start.x;
  const at = Math.min(high - inset, Math.max(low + inset, current));

  const centerA = getElementCenter(from);
  const centerB = getElementCenter(to);
  const startHit = facingPoint(from, axis, at, axis === "x" ? centerB.x : centerB.y);
  const endHit = facingPoint(to, axis, at, axis === "x" ? centerA.x : centerA.y);
  if (!startHit || !endHit) return false;
  const direction = axis === "x" ? Math.sign(endHit.x - startHit.x) : Math.sign(endHit.y - startHit.y);
  if (!direction) return false;
  const startGap = arrow.startBinding.gap ?? 4;
  const endGap = arrow.endBinding.gap ?? 4;
  const shift = (point: Point, by: number): Point =>
    axis === "x" ? { x: point.x + by, y: point.y } : { x: point.x, y: point.y + by };
  setPoint(arrow, 0, shift(startHit, direction * startGap));
  setPoint(arrow, 1, shift(endHit, -direction * endGap));
  normalizePoints(arrow);
  return true;
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

  const gap = binding.gap ?? 4;
  if (straightenSegment(arrow, endpoint, shape, gap)) {
    normalizePoints(arrow);
    return true;
  }

  const intersection = getOutlineIntersection(shape, neighbor);
  const dx = neighbor.x - center.x;
  const dy = neighbor.y - center.y;
  const length = Math.hypot(dx, dy) || 1;
  const target: Point = {
    x: intersection.x + (dx / length) * gap,
    y: intersection.y + (dy / length) * gap,
  };

  setPoint(arrow, index, target);
  normalizePoints(arrow);
  return true;
}

/** Both ends of one arrow, preferring a straight line when one fits. */
function updateArrowEnds(arrow: LinearElement, elements: readonly AxElement[]): void {
  if (straightenBetween(arrow, elements)) return;
  updateBoundPoint(arrow, "start", elements);
  updateBoundPoint(arrow, "end", elements);
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
      updateArrowEnds(arrow, elements);
    }
  }
}

/** Refresh both endpoints of the given arrows (after editing the arrow itself). */
export function refreshArrowBindings(arrows: readonly AxElement[], elements: readonly AxElement[]): void {
  for (const arrow of arrows) {
    if (!isLinear(arrow)) continue;
    updateArrowEnds(arrow, elements);
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
