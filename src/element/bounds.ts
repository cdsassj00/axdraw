/** Geometry helpers: bounding boxes, rotation and coordinate transforms. */

import type { AxElement, Bounds, LinearElement, FreedrawElement, Point } from "../types";

export function rotate(x: number, y: number, cx: number, cy: number, angle: number): [number, number] {
  if (!angle) return [x, y];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [(x - cx) * cos - (y - cy) * sin + cx, (x - cx) * sin + (y - cy) * cos + cy];
}

export function rotatePoint(point: Point, center: Point, angle: number): Point {
  const [x, y] = rotate(point.x, point.y, center.x, center.y, angle);
  return { x, y };
}

export function isLinear(element: AxElement): element is LinearElement {
  return element.type === "line" || element.type === "arrow";
}

export function isFreedraw(element: AxElement): element is FreedrawElement {
  return element.type === "freedraw";
}

export function hasPoints(element: AxElement): element is LinearElement | FreedrawElement {
  return isLinear(element) || isFreedraw(element);
}

/** Unrotated element box plus its centre. */
export function getElementAbsoluteCoords(
  element: AxElement,
): [x1: number, y1: number, x2: number, y2: number, cx: number, cy: number] {
  const x1 = element.x;
  const y1 = element.y;
  const x2 = element.x + element.width;
  const y2 = element.y + element.height;
  return [x1, y1, x2, y2, (x1 + x2) / 2, (y1 + y2) / 2];
}

/** Axis-aligned bounds of the element *after* rotation. */
export function getElementBounds(element: AxElement): Bounds {
  const [x1, y1, x2, y2, cx, cy] = getElementAbsoluteCoords(element);
  if (!element.angle) return { x1, y1, x2, y2 };
  const corners: [number, number][] = [
    rotate(x1, y1, cx, cy, element.angle),
    rotate(x2, y1, cx, cy, element.angle),
    rotate(x2, y2, cx, cy, element.angle),
    rotate(x1, y2, cx, cy, element.angle),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

export function getCommonBounds(elements: readonly AxElement[]): Bounds {
  if (!elements.length) return { x1: 0, y1: 0, x2: 0, y2: 0 };
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const element of elements) {
    const b = getElementBounds(element);
    x1 = Math.min(x1, b.x1);
    y1 = Math.min(y1, b.y1);
    x2 = Math.max(x2, b.x2);
    y2 = Math.max(y2, b.y2);
  }
  return { x1, y1, x2, y2 };
}

export function getBoundsWidth(bounds: Bounds): number {
  return bounds.x2 - bounds.x1;
}

export function getBoundsHeight(bounds: Bounds): number {
  return bounds.y2 - bounds.y1;
}

export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return !(a.x2 < b.x1 || a.x1 > b.x2 || a.y2 < b.y1 || a.y1 > b.y2);
}

export function boundsContain(outer: Bounds, inner: Bounds): boolean {
  return outer.x1 <= inner.x1 && outer.y1 <= inner.y1 && outer.x2 >= inner.x2 && outer.y2 >= inner.y2;
}

export function pointInBounds(point: Point, bounds: Bounds): boolean {
  return point.x >= bounds.x1 && point.x <= bounds.x2 && point.y >= bounds.y1 && point.y <= bounds.y2;
}

export function getElementCenter(element: AxElement): Point {
  return { x: element.x + element.width / 2, y: element.y + element.height / 2 };
}

/** Scene point → element-local (unrotated) coordinates. */
export function toLocalCoords(element: AxElement, point: Point): Point {
  const center = getElementCenter(element);
  const [x, y] = rotate(point.x, point.y, center.x, center.y, -element.angle);
  return { x: x - element.x, y: y - element.y };
}

/** Absolute scene coordinates of a linear/freedraw element's points. */
export function getPointsAbsolute(element: LinearElement | FreedrawElement): Point[] {
  const center = getElementCenter(element);
  return element.points.map(([px, py]) => {
    const [x, y] = rotate(element.x + px, element.y + py, center.x, center.y, element.angle);
    return { x, y };
  });
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Shortest distance from `p` to segment `a`–`b`. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Recompute x/y/width/height from the point list, keeping points relative. */
export function normalizePoints(element: LinearElement | FreedrawElement): void {
  const points = element.points;
  if (!points.length) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (minX !== 0 || minY !== 0) {
    element.points = points.map(([x, y]) => [x - minX, y - minY] as [number, number]);
    element.x += minX;
    element.y += minY;
  }
  element.width = maxX - minX;
  element.height = maxY - minY;
}
