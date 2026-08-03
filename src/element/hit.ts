/** Hit testing: which element is under the pointer. */

import type { AxElement, Bounds, LinearElement, Point } from "../types";
import {
  distanceToSegment,
  getElementBounds,
  getElementCenter,
  rotate,
  toLocalCoords,
} from "./bounds";

/** Point in element-local space (origin at the element's top-left, unrotated). */
function localPoint(element: AxElement, point: Point): Point {
  return toLocalCoords(element, point);
}

function distanceToRectOutline(p: Point, w: number, h: number): number {
  const dx = Math.max(0 - p.x, p.x - w, 0);
  const dy = Math.max(0 - p.y, p.y - h, 0);
  const outside = Math.hypot(dx, dy);
  if (outside > 0) return outside;
  // Inside: distance to the nearest edge.
  return Math.min(p.x, w - p.x, p.y, h - p.y);
}

function isInsideRect(p: Point, w: number, h: number): boolean {
  return p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h;
}

function diamondVertices(w: number, h: number): Point[] {
  return [
    { x: w / 2, y: 0 },
    { x: w, y: h / 2 },
    { x: w / 2, y: h },
    { x: 0, y: h / 2 },
  ];
}

function distanceToPolygonOutline(p: Point, vertices: Point[]): number {
  let min = Infinity;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    min = Math.min(min, distanceToSegment(p, a, b));
  }
  return min;
}

export function isPointInPolygon(p: Point, vertices: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const vi = vertices[i];
    const vj = vertices[j];
    if (vi.y > p.y !== vj.y > p.y && p.x < ((vj.x - vi.x) * (p.y - vi.y)) / (vj.y - vi.y) + vi.x) {
      inside = !inside;
    }
  }
  return inside;
}

function ellipseMetrics(p: Point, w: number, h: number): { q: number; outlineDistance: number } {
  const rx = Math.abs(w / 2) || 0.0001;
  const ry = Math.abs(h / 2) || 0.0001;
  const dx = p.x - w / 2;
  const dy = p.y - h / 2;
  const q = Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2);
  const radial = Math.hypot(dx, dy);
  const outlineDistance = q === 0 ? Math.min(rx, ry) : Math.abs(radial * (1 - 1 / q));
  return { q, outlineDistance };
}

export function isFilled(element: AxElement): boolean {
  return element.backgroundColor !== "transparent" && element.backgroundColor !== "";
}

/** Does `point` (scene coords) hit `element` within `threshold` scene units? */
export function hitTest(element: AxElement, point: Point, threshold: number): boolean {
  if (element.isDeleted) return false;
  const p = localPoint(element, point);
  const w = element.width;
  const h = element.height;

  switch (element.type) {
    case "rectangle":
      return isFilled(element)
        ? isInsideRect(p, w, h) || distanceToRectOutline(p, w, h) <= threshold
        : distanceToRectOutline(p, w, h) <= threshold && !isDeepInside(p, w, h, threshold);
    case "image":
      return isInsideRect(p, w, h);
    case "text":
      return isInsideRect(p, w, h);
    case "frame":
      // Frames are grabbed by their border or their name tag.
      return (
        distanceToRectOutline(p, w, h) <= threshold ||
        (p.y < 0 && p.y > -25 && p.x >= 0 && p.x <= w)
      );
    case "diamond": {
      const vertices = diamondVertices(w, h);
      if (isFilled(element) && isPointInPolygon(p, vertices)) return true;
      return distanceToPolygonOutline(p, vertices) <= threshold;
    }
    case "ellipse": {
      const { q, outlineDistance } = ellipseMetrics(p, w, h);
      if (isFilled(element) && q <= 1) return true;
      return outlineDistance <= threshold;
    }
    case "line":
    case "arrow":
    case "freedraw": {
      const points = element.points;
      if (points.length === 1) {
        return Math.hypot(p.x - points[0][0], p.y - points[0][1]) <= threshold;
      }
      let min = Infinity;
      for (let i = 0; i < points.length - 1; i++) {
        min = Math.min(
          min,
          distanceToSegment(
            p,
            { x: points[i][0], y: points[i][1] },
            { x: points[i + 1][0], y: points[i + 1][1] },
          ),
        );
        if (min <= threshold) return true;
      }
      if (isFilled(element)) {
        const polygon = points.map(([x, y]) => ({ x, y }));
        if (isPointInPolygon(p, polygon)) return true;
      }
      return min <= threshold;
    }
    default:
      return isInsideRect(p, w, h);
  }
}

/** Used to let clicks pass through the hollow middle of unfilled rectangles. */
function isDeepInside(p: Point, w: number, h: number, threshold: number): boolean {
  return p.x > threshold && p.y > threshold && p.x < w - threshold && p.y < h - threshold;
}

export function getElementAtPosition(
  elements: readonly AxElement[],
  point: Point,
  threshold: number,
  filter?: (element: AxElement) => boolean,
): AxElement | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const element = elements[i];
    if (element.isDeleted || element.locked) continue;
    if (filter && !filter(element)) continue;
    if (hitTest(element, point, threshold)) return element;
  }
  return null;
}

/** Marquee selection: elements whose bounds intersect the selection box. */
export function getElementsInBounds(elements: readonly AxElement[], bounds: Bounds): AxElement[] {
  return elements.filter((element) => {
    if (element.isDeleted || element.locked) return false;
    const b = getElementBounds(element);
    return !(b.x2 < bounds.x1 || b.x1 > bounds.x2 || b.y2 < bounds.y1 || b.y1 > bounds.y2);
  });
}

/** Index of the linear element point near `point`, or -1. */
export function getLinearPointIndexAt(
  element: LinearElement,
  point: Point,
  threshold: number,
): number {
  const center = getElementCenter(element);
  for (let i = 0; i < element.points.length; i++) {
    const [px, py] = element.points[i];
    const [ax, ay] = rotate(element.x + px, element.y + py, center.x, center.y, element.angle);
    if (Math.hypot(ax - point.x, ay - point.y) <= threshold) return i;
  }
  return -1;
}

/** Midpoint index (between i and i+1) near `point`, or -1. */
export function getLinearMidpointIndexAt(
  element: LinearElement,
  point: Point,
  threshold: number,
): number {
  const center = getElementCenter(element);
  for (let i = 0; i < element.points.length - 1; i++) {
    const [x1, y1] = element.points[i];
    const [x2, y2] = element.points[i + 1];
    const [ax, ay] = rotate(
      element.x + (x1 + x2) / 2,
      element.y + (y1 + y2) / 2,
      center.x,
      center.y,
      element.angle,
    );
    if (Math.hypot(ax - point.x, ay - point.y) <= threshold) return i;
  }
  return -1;
}
