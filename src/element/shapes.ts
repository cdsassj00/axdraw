/**
 * Turns elements into hand-drawn geometry.
 *
 * Generation is the expensive half of rendering, so results are cached per
 * element version — panning and zooming replay cached op-sets, and only an
 * actual edit regenerates.
 */

import { ROUNDNESS_MAX_RADIUS, ROUNDNESS_PROPORTION } from "../constants";
import * as rough from "../rough/generator";
import type { Drawable, Point as RPoint, RoughOptions } from "../rough/types";
import type { AxElement, FreedrawElement, LinearElement } from "../types";
import { getSvgPathFromStroke, getStroke, type InputPoint } from "../utils/freehand";

export interface ElementShape {
  drawables: Drawable[];
  lineDash: number[] | null;
}

const shapeCache = new Map<string, { version: number; shape: ElementShape }>();
const freedrawCache = new Map<string, { version: number; path: Path2D; svg: string }>();

export function invalidateShape(id: string): void {
  shapeCache.delete(id);
  freedrawCache.delete(id);
}

export function clearShapeCache(): void {
  shapeCache.clear();
  freedrawCache.clear();
}

export function getDashArray(element: AxElement): number[] | null {
  if (element.strokeStyle === "dashed") return [8, 8 + element.strokeWidth];
  if (element.strokeStyle === "dotted") return [1.5, 6 + element.strokeWidth];
  return null;
}

/** Small shapes get calmer wobble, otherwise they turn into scribbles. */
function adjustRoughness(element: AxElement): number {
  const roughness = element.roughness;
  const maxSize = Math.max(Math.abs(element.width), Math.abs(element.height));
  const minSize = Math.min(Math.abs(element.width), Math.abs(element.height));
  if (maxSize >= 50 && minSize >= 20) return roughness;
  return Math.min(roughness / (minSize < 10 ? 3 : 2), 2.5);
}

export function roughOptionsFor(element: AxElement, continuousPath = false): RoughOptions {
  const dashed = element.strokeStyle !== "solid";
  const roughness = adjustRoughness(element);
  return {
    seed: element.seed,
    strokeWidth: dashed ? element.strokeWidth + 0.5 : element.strokeWidth,
    stroke: element.strokeColor,
    fill: element.backgroundColor === "transparent" ? null : element.backgroundColor,
    fillStyle: element.fillStyle,
    fillWeight: element.strokeWidth / 2,
    hachureGap: element.strokeWidth * 4,
    roughness,
    disableMultiStroke: dashed,
    preserveVertices: continuousPath || roughness < 1,
  };
}

export function getCornerRadius(dimension: number, element: AxElement): number {
  if (!element.roundness) return 0;
  if (element.roundness.type === "sharp") return 0;
  const proportional = dimension * ROUNDNESS_PROPORTION;
  return proportional <= ROUNDNESS_MAX_RADIUS ? proportional : ROUNDNESS_MAX_RADIUS;
}

/**
 * Insert intermediate points wherever consecutive samples are far apart.
 *
 * The closed Catmull-Rom generator derives each segment's tangents from its
 * neighbours, so a long straight edge sitting next to a densely sampled corner
 * arc produces huge control offsets (~edge/6) that shoot the curve straight
 * past the corner — the taller the rectangle, the longer the spike. Bounding
 * the spacing bounds the tangents, which keeps edges inside their corners.
 */
function densify(points: RPoint[], maxSpacing = 24): RPoint[] {
  const result: RPoint[] = [];
  const count = points.length;
  for (let i = 0; i < count; i++) {
    const curr = points[i];
    const next = points[(i + 1) % count];
    result.push(curr);
    const distance = Math.hypot(next[0] - curr[0], next[1] - curr[1]);
    const splits = Math.floor(distance / maxSpacing);
    for (let s = 1; s <= splits; s++) {
      const t = s / (splits + 1);
      result.push([curr[0] + (next[0] - curr[0]) * t, curr[1] + (next[1] - curr[1]) * t]);
    }
  }
  return result;
}

/** Sample a polygon outline with rounded corners into a dense point list. */
function roundedPolygonPoints(points: RPoint[], radius: number, samples = 8): RPoint[] {
  if (radius <= 0) return points;
  const result: RPoint[] = [];
  const count = points.length;
  for (let i = 0; i < count; i++) {
    const prev = points[(i - 1 + count) % count];
    const curr = points[i];
    const next = points[(i + 1) % count];

    const toPrev = [prev[0] - curr[0], prev[1] - curr[1]];
    const toNext = [next[0] - curr[0], next[1] - curr[1]];
    const lenPrev = Math.hypot(toPrev[0], toPrev[1]) || 1;
    const lenNext = Math.hypot(toNext[0], toNext[1]) || 1;
    const r = Math.min(radius, lenPrev / 2, lenNext / 2);

    const start: RPoint = [curr[0] + (toPrev[0] / lenPrev) * r, curr[1] + (toPrev[1] / lenPrev) * r];
    const end: RPoint = [curr[0] + (toNext[0] / lenNext) * r, curr[1] + (toNext[1] / lenNext) * r];

    result.push(start);
    // Quadratic arc through the corner, sampled so the curve generator can
    // follow it while leaving the straight edges straight.
    for (let s = 1; s < samples; s++) {
      const t = s / samples;
      const mt = 1 - t;
      result.push([
        mt * mt * start[0] + 2 * mt * t * curr[0] + t * t * end[0],
        mt * mt * start[1] + 2 * mt * t * curr[1] + t * t * end[1],
      ]);
    }
    result.push(end);
  }
  return densify(result);
}

function rectanglePoints(element: AxElement): RPoint[] {
  const { x, y, width: w, height: h } = element;
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

function diamondPoints(element: AxElement): RPoint[] {
  const { x, y, width: w, height: h } = element;
  return [
    [x + w / 2, y],
    [x + w, y + h / 2],
    [x + w / 2, y + h],
    [x, y + h / 2],
  ];
}

/* ------------------------------------------------------------------ *
 * Arrowheads
 * ------------------------------------------------------------------ */

export interface ArrowheadGeometry {
  /** Stroked lines (barbed arrow, bar). */
  lines: [RPoint, RPoint][];
  /** Filled polygon (triangle, diamond, dot). */
  polygon: RPoint[] | null;
  /** Outlined but unfilled polygon. */
  outline: RPoint[] | null;
}

export function getArrowheadGeometry(
  element: LinearElement,
  position: "start" | "end",
  points: RPoint[],
): ArrowheadGeometry | null {
  const type = position === "start" ? element.startArrowhead : element.endArrowhead;
  if (!type || type === "none" || points.length < 2) return null;

  const index = position === "start" ? 0 : points.length - 1;
  const neighborIndex = position === "start" ? 1 : points.length - 2;
  const [x2, y2] = points[index];
  const [x1, y1] = points[neighborIndex];

  const angle = Math.atan2(y2 - y1, x2 - x1);
  const distance = Math.hypot(x2 - x1, y2 - y1);
  const size = Math.max(
    Math.min(distance / 2, 30 + element.strokeWidth * 2),
    8 + element.strokeWidth * 2,
  );

  const point = (dist: number, spread: number): RPoint => [
    x2 - dist * Math.cos(angle + spread),
    y2 - dist * Math.sin(angle + spread),
  ];

  switch (type) {
    case "arrow": {
      const spread = Math.PI / 7;
      return { lines: [[[x2, y2], point(size, spread)], [[x2, y2], point(size, -spread)]], polygon: null, outline: null };
    }
    case "bar": {
      const barSize = 8 + element.strokeWidth * 2;
      const nx = Math.cos(angle + Math.PI / 2);
      const ny = Math.sin(angle + Math.PI / 2);
      return {
        lines: [[[x2 - nx * barSize, y2 - ny * barSize], [x2 + nx * barSize, y2 + ny * barSize]]],
        polygon: null,
        outline: null,
      };
    }
    case "triangle":
    case "triangle-outline": {
      const spread = Math.PI / 8;
      const polygon: RPoint[] = [[x2, y2], point(size, spread), point(size, -spread)];
      return type === "triangle"
        ? { lines: [], polygon, outline: null }
        : { lines: [], polygon: null, outline: polygon };
    }
    case "diamond": {
      const spread = Math.PI / 6;
      const polygon: RPoint[] = [
        [x2, y2],
        point(size * 0.7, spread),
        point(size * 1.3, 0),
        point(size * 0.7, -spread),
      ];
      return { lines: [], polygon, outline: null };
    }
    case "dot": {
      const r = 3 + element.strokeWidth * 1.5;
      const polygon: RPoint[] = [];
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        polygon.push([x2 + Math.cos(a) * r, y2 + Math.sin(a) * r]);
      }
      return { lines: [], polygon, outline: null };
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Element → drawables
 * ------------------------------------------------------------------ */

function generate(element: AxElement): ElementShape | null {
  const lineDash = getDashArray(element);

  switch (element.type) {
    case "rectangle":
    case "frame": {
      const radius = getCornerRadius(Math.min(Math.abs(element.width), Math.abs(element.height)), element);
      const options = roughOptionsFor(element, radius > 0);
      const base = rectanglePoints(element);
      const drawable =
        radius > 0
          ? rough.closedCurve(roundedPolygonPoints(base, radius), options)
          : rough.rectangle(element.x, element.y, element.width, element.height, options);
      return { drawables: [drawable], lineDash };
    }
    case "diamond": {
      const radius = getCornerRadius(Math.min(Math.abs(element.width), Math.abs(element.height)), element);
      const options = roughOptionsFor(element, radius > 0);
      const base = diamondPoints(element);
      const drawable =
        radius > 0
          ? rough.closedCurve(roundedPolygonPoints(base, radius / 2), options)
          : rough.polygon(base, options);
      return { drawables: [drawable], lineDash };
    }
    case "ellipse": {
      const options = roughOptionsFor(element);
      return {
        drawables: [rough.ellipse(element.x, element.y, element.width, element.height, options)],
        lineDash,
      };
    }
    case "line":
    case "arrow": {
      const linear = element as LinearElement;
      const curved = linear.roundness?.type === "round" && !linear.elbowed;
      const options = roughOptionsFor(element, curved);
      const points: RPoint[] = linear.points.map(([px, py]) => [element.x + px, element.y + py]);
      if (points.length < 2) return { drawables: [], lineDash };

      const drawables: Drawable[] = [];
      const closed =
        linear.type === "line" &&
        points.length > 2 &&
        Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1]) < 1;

      if (closed) {
        drawables.push(
          curved ? rough.closedCurve(points.slice(0, -1), options) : rough.polygon(points.slice(0, -1), options),
        );
      } else if (points.length === 2) {
        drawables.push(rough.line(points[0][0], points[0][1], points[1][0], points[1][1], options));
      } else {
        drawables.push(curved ? rough.curve(points, options) : rough.linearPath(points, options));
      }

      if (linear.type === "arrow") {
        for (const position of ["start", "end"] as const) {
          const head = getArrowheadGeometry(linear, position, points);
          if (!head) continue;
          const headOptions: RoughOptions = { ...options, fill: element.strokeColor, fillStyle: "solid" };
          for (const [a, b] of head.lines) {
            drawables.push(rough.line(a[0], a[1], b[0], b[1], { ...options, disableMultiStroke: true }));
          }
          if (head.polygon) drawables.push(rough.polygon(head.polygon, { ...headOptions, roughness: 0 }));
          if (head.outline) {
            drawables.push(rough.polygon(head.outline, { ...options, fill: null, disableMultiStroke: true }));
          }
        }
      }
      return { drawables, lineDash };
    }
    default:
      return null;
  }
}

export function getElementShape(element: AxElement): ElementShape | null {
  const cached = shapeCache.get(element.id);
  if (cached && cached.version === element.version) return cached.shape;
  const shape = generate(element);
  if (shape) shapeCache.set(element.id, { version: element.version, shape });
  return shape;
}

/* ------------------------------------------------------------------ *
 * Freedraw
 * ------------------------------------------------------------------ */

export function getFreedrawStroke(element: FreedrawElement): { path: Path2D; svg: string } {
  const cached = freedrawCache.get(element.id);
  if (cached && cached.version === element.version) return { path: cached.path, svg: cached.svg };

  const inputPoints: InputPoint[] = element.points.map(([x, y], index) => {
    const pressure = element.simulatePressure ? 0.5 : (element.pressures[index] ?? 0.5);
    return [element.x + x, element.y + y, pressure] as InputPoint;
  });

  const outline = getStroke(inputPoints, {
    simulatePressure: element.simulatePressure,
    size: element.strokeWidth * 4.25,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    easing: (t) => Math.sin((t * Math.PI) / 2),
    last: true,
  });

  const svg = getSvgPathFromStroke(outline);
  const path = new Path2D(svg);
  freedrawCache.set(element.id, { version: element.version, path, svg });
  return { path, svg };
}
