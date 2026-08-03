/**
 * Hand-drawn geometry generator.
 *
 * Produces `Drawable`s — pure op-set descriptions of a sketchy shape — from
 * plain geometry. The wobble is driven by the element seed, so a shape looks
 * identical every frame, in exports, and after a reload.
 */

import { mulberry32 } from "../utils/random";
import {
  dashedLines,
  dotsAlongLines,
  polygonHachureLines,
  zigzagLines,
  type Segment,
} from "./fillers";
import {
  DEFAULT_OPTIONS,
  type Drawable,
  type Op,
  type OpSet,
  type Point,
  type ResolvedOptions,
  type RoughOptions,
} from "./types";

export function resolveOptions(options: RoughOptions = {}): ResolvedOptions {
  const merged = { ...DEFAULT_OPTIONS, ...options } as ResolvedOptions;
  merged.random = mulberry32(merged.seed || 1);
  return merged;
}

function offset(min: number, max: number, o: ResolvedOptions, gain = 1): number {
  return o.roughness * gain * (o.random() * (max - min) + min);
}

function offsetOpt(x: number, o: ResolvedOptions, gain = 1): number {
  return offset(-x, x, o, gain);
}

/** Core sketchy line. `move` emits a leading move op; `overlay` is pass two. */
function lineOps(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  o: ResolvedOptions,
  move: boolean,
  overlay: boolean,
): Op[] {
  const lengthSq = (x1 - x2) ** 2 + (y1 - y2) ** 2;
  const length = Math.sqrt(lengthSq);

  // Long lines get proportionally less wobble, otherwise they look drunk.
  let gain = 1;
  if (length > 500) gain = 0.4;
  else if (length > 200) gain = -0.0016668 * length + 1.233334;

  let randomness = o.maxRandomnessOffset || 0;
  if (randomness * randomness * 100 > lengthSq) randomness = length / 10;
  const halfOffset = randomness / 2;
  const divergePoint = 0.2 + o.random() * 0.2;

  let midDispX = (o.bowing * o.maxRandomnessOffset * (y2 - y1)) / 200;
  let midDispY = (o.bowing * o.maxRandomnessOffset * (x1 - x2)) / 200;
  midDispX = offsetOpt(midDispX, o, gain);
  midDispY = offsetOpt(midDispY, o, gain);

  const ops: Op[] = [];
  const rand = () => offsetOpt(overlay ? halfOffset : randomness, o, gain);
  const keep = o.preserveVertices;

  if (move) {
    ops.push({
      op: "move",
      data: [x1 + (keep ? 0 : rand()), y1 + (keep ? 0 : rand())],
    });
  }
  ops.push({
    op: "bcurveTo",
    data: [
      midDispX + x1 + (x2 - x1) * divergePoint + rand(),
      midDispY + y1 + (y2 - y1) * divergePoint + rand(),
      midDispX + x1 + 2 * (x2 - x1) * divergePoint + rand(),
      midDispY + y1 + 2 * (y2 - y1) * divergePoint + rand(),
      x2 + (keep ? 0 : rand()),
      y2 + (keep ? 0 : rand()),
    ],
  });
  return ops;
}

/** Two overlapping passes — the signature "drawn by hand twice" look. */
function doubleLineOps(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  o: ResolvedOptions,
): Op[] {
  if (o.disableMultiStroke) return lineOps(x1, y1, x2, y2, o, true, false);
  return [
    ...lineOps(x1, y1, x2, y2, o, true, false),
    ...lineOps(x1, y1, x2, y2, o, true, true),
  ];
}

interface CurveMode {
  /** Wrap the spline around so the first and last vertex join smoothly. */
  closed?: boolean;
  /**
   * Treat the first and last entries as control points only — the curve then
   * starts at `points[1]` and ends at `points[n-2]`. Used by the ellipse, whose
   * generator deliberately overshoots the closing point.
   */
  controlEnds?: boolean;
}

function curveOps(points: Point[], o: ResolvedOptions, mode: CurveMode = {}): Op[] {
  const ops: Op[] = [];
  const len = points.length;
  const s = 1 - o.curveTightness;

  if (mode.closed) {
    if (len < 3) return len === 2 ? doubleLineOps(points[0][0], points[0][1], points[1][0], points[1][1], o) : ops;
    const at = (index: number): Point => points[((index % len) + len) % len];
    ops.push({ op: "move", data: [at(0)[0], at(0)[1]] });
    for (let i = 0; i < len; i++) {
      const p0 = at(i - 1);
      const p1 = at(i);
      const p2 = at(i + 1);
      const p3 = at(i + 2);
      ops.push({
        op: "bcurveTo",
        data: [
          p1[0] + (s * (p2[0] - p0[0])) / 6,
          p1[1] + (s * (p2[1] - p0[1])) / 6,
          p2[0] - (s * (p3[0] - p1[0])) / 6,
          p2[1] - (s * (p3[1] - p1[1])) / 6,
          p2[0],
          p2[1],
        ],
      });
    }
    return ops;
  }

  if (len < 3) {
    if (len === 2) return doubleLineOps(points[0][0], points[0][1], points[1][0], points[1][1], o);
    return ops;
  }

  // Catmull-Rom through the points, converted to cubic Béziers. Duplicating
  // the endpoints makes the curve pass through the first and last vertex.
  const pts: Point[] = mode.controlEnds ? points : [points[0], ...points, points[len - 1]];
  ops.push({ op: "move", data: [pts[1][0], pts[1][1]] });
  for (let i = 1; i + 2 < pts.length; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    const after = pts[i + 2];
    ops.push({
      op: "bcurveTo",
      data: [
        cur[0] + (s * next[0] - s * prev[0]) / 6,
        cur[1] + (s * next[1] - s * prev[1]) / 6,
        next[0] + (s * cur[0] - s * after[0]) / 6,
        next[1] + (s * cur[1] - s * after[1]) / 6,
        next[0],
        next[1],
      ],
    });
  }
  return ops;
}

/**
 * Displace points to make a curve look hand-drawn.
 *
 * The displacement is scaled down where samples are dense (the arcs of a
 * rounded corner, a tightly sampled freehand stroke): jittering those at full
 * strength turns a smooth corner into a jagged notch, while long straight runs
 * still get the full wobble.
 */
function jitterPoints(points: Point[], o: ResolvedOptions, amount: number): Point[] {
  return points.map(([x, y], index) => {
    const previous = points[index === 0 ? points.length - 1 : index - 1];
    const spacing = Math.hypot(x - previous[0], y - previous[1]);
    const scale = Math.max(0.15, Math.min(1, spacing / 12));
    return [x + offsetOpt(amount * scale, o), y + offsetOpt(amount * scale, o)] as Point;
  });
}

function curveWithOffset(
  points: Point[],
  amount: number,
  o: ResolvedOptions,
  mode: CurveMode = {},
): Op[] {
  if (points.length < 2) return [];
  return curveOps(jitterPoints(points, o, amount), o, mode);
}

/* ------------------------------------------------------------------ *
 * Fills
 * ------------------------------------------------------------------ */

function segmentsToOps(lines: Segment[], o: ResolvedOptions): Op[] {
  const ops: Op[] = [];
  for (const [a, b] of lines) {
    ops.push(...lineOps(a[0], a[1], b[0], b[1], o, true, true));
  }
  return ops;
}

function connectedSegmentsToOps(lines: Segment[], o: ResolvedOptions): Op[] {
  const ops: Op[] = [];
  let first = true;
  for (const [a, b] of lines) {
    ops.push(...lineOps(a[0], a[1], b[0], b[1], o, first, false));
    first = false;
  }
  return ops;
}

function solidFillOps(polygons: Point[][]): Op[] {
  const ops: Op[] = [];
  for (const polygon of polygons) {
    if (polygon.length < 2) continue;
    ops.push({ op: "move", data: [polygon[0][0], polygon[0][1]] });
    for (let i = 1; i < polygon.length; i++) {
      ops.push({ op: "lineTo", data: [polygon[i][0], polygon[i][1]] });
    }
    ops.push({ op: "lineTo", data: [polygon[0][0], polygon[0][1]] });
  }
  return ops;
}

/** Build the fill op-set for a closed shape, or `null` when there is no fill. */
function buildFill(polygons: Point[][], o: ResolvedOptions): OpSet | null {
  if (!o.fill) return null;
  if (o.fillStyle === "solid") {
    return { type: "fillPath", ops: solidFillOps(polygons) };
  }

  const gap = o.hachureGap < 0 ? o.strokeWidth * 4 : o.hachureGap;
  const fillOptions: ResolvedOptions = {
    ...o,
    // Fill strokes are thinner and calmer than outlines.
    maxRandomnessOffset: Math.min(o.maxRandomnessOffset, 2),
    disableMultiStroke: o.disableMultiStrokeFill,
  };
  const hachureConfig = {
    hachureAngle: o.hachureAngle,
    hachureGap: gap,
    strokeWidth: o.strokeWidth,
    roughness: o.roughness,
    random: o.random,
  };

  switch (o.fillStyle) {
    case "cross-hatch": {
      const a = polygonHachureLines(polygons, hachureConfig);
      const b = polygonHachureLines(polygons, {
        ...hachureConfig,
        hachureAngle: o.hachureAngle + 90,
      });
      return { type: "fillSketch", ops: segmentsToOps([...a, ...b], fillOptions) };
    }
    case "zigzag": {
      const lines = polygonHachureLines(polygons, hachureConfig);
      return {
        type: "fillSketch",
        ops: connectedSegmentsToOps(zigzagLines(lines), fillOptions),
      };
    }
    case "dots": {
      const lines = polygonHachureLines(polygons, { ...hachureConfig, hachureGap: gap });
      const dots = dotsAlongLines(lines, gap, o.random);
      const ops: Op[] = [];
      const r = Math.max(o.fillWeight < 0 ? o.strokeWidth / 2 : o.fillWeight / 2, 0.4);
      for (const [x, y] of dots) {
        // Approximate a filled dot with a tiny closed cubic loop.
        ops.push({ op: "move", data: [x - r, y] });
        ops.push({ op: "bcurveTo", data: [x - r, y - r * 1.34, x + r, y - r * 1.34, x + r, y] });
        ops.push({ op: "bcurveTo", data: [x + r, y + r * 1.34, x - r, y + r * 1.34, x - r, y] });
      }
      return { type: "fillPath", ops };
    }
    case "dashed": {
      const lines = polygonHachureLines(polygons, hachureConfig);
      const dashOffset = o.dashOffset < 0 ? gap : o.dashOffset;
      const dashGap = o.dashGap < 0 ? gap : o.dashGap;
      return {
        type: "fillSketch",
        ops: segmentsToOps(dashedLines(lines, dashOffset, dashGap), fillOptions),
      };
    }
    case "hachure":
    default: {
      const lines = polygonHachureLines(polygons, hachureConfig);
      return { type: "fillSketch", ops: segmentsToOps(lines, fillOptions) };
    }
  }
}

/* ------------------------------------------------------------------ *
 * Public shape generators
 * ------------------------------------------------------------------ */

export function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  options: RoughOptions = {},
): Drawable {
  const o = resolveOptions(options);
  return { shape: "line", sets: [{ type: "path", ops: doubleLineOps(x1, y1, x2, y2, o) }], options: o };
}

function polygonOutlineOps(points: Point[], o: ResolvedOptions, close: boolean): Op[] {
  const ops: Op[] = [];
  if (points.length < 2) return ops;
  const pass = (opts: ResolvedOptions) => {
    for (let i = 0; i < points.length - 1; i++) {
      ops.push(...lineOps(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], opts, i === 0, false));
    }
    if (close) {
      const last = points[points.length - 1];
      ops.push(...lineOps(last[0], last[1], points[0][0], points[0][1], opts, false, false));
    }
  };
  pass(o);
  if (!o.disableMultiStroke) {
    const overlay: ResolvedOptions = { ...o };
    for (let i = 0; i < points.length - 1; i++) {
      ops.push(...lineOps(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], overlay, i === 0, true));
    }
    if (close) {
      const last = points[points.length - 1];
      ops.push(...lineOps(last[0], last[1], points[0][0], points[0][1], overlay, false, true));
    }
  }
  return ops;
}

export function polygon(points: Point[], options: RoughOptions = {}): Drawable {
  const o = resolveOptions(options);
  const sets: OpSet[] = [];
  const fill = buildFill([points], o);
  if (fill) sets.push(fill);
  sets.push({ type: "path", ops: polygonOutlineOps(points, o, true) });
  return { shape: "polygon", sets, options: o };
}

export function linearPath(points: Point[], options: RoughOptions = {}): Drawable {
  const o = resolveOptions(options);
  return { shape: "linearPath", sets: [{ type: "path", ops: polygonOutlineOps(points, o, false) }], options: o };
}

export function rectangle(
  x: number,
  y: number,
  width: number,
  height: number,
  options: RoughOptions = {},
): Drawable {
  const points: Point[] = [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height],
  ];
  const drawable = polygon(points, options);
  drawable.shape = "rectangle";
  return drawable;
}

function ellipseParams(width: number, height: number, o: ResolvedOptions) {
  const psq = Math.max(
    Math.sqrt(Math.PI * 2 * Math.sqrt(((width / 2) ** 2 + (height / 2) ** 2) / 2)),
    5,
  );
  const stepCount = Math.max(o.curveStepCount, (o.curveStepCount / Math.sqrt(200)) * psq);
  const increment = (Math.PI * 2) / stepCount;
  let rx = Math.abs(width / 2);
  let ry = Math.abs(height / 2);
  const curveFitRandomness = 1 - o.curveFitting;
  rx += offsetOpt(rx * curveFitRandomness, o);
  ry += offsetOpt(ry * curveFitRandomness, o);
  return { increment, rx, ry };
}

function computeEllipsePoints(
  increment: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  offsetAmount: number,
  overlap: number,
  o: ResolvedOptions,
): { corePoints: Point[]; allPoints: Point[] } {
  const corePoints: Point[] = [];
  const allPoints: Point[] = [];
  const radOffset = offsetOpt(0.5, o) - Math.PI / 2;

  allPoints.push([
    offsetOpt(offsetAmount, o) + cx + 0.9 * rx * Math.cos(radOffset - increment),
    offsetOpt(offsetAmount, o) + cy + 0.9 * ry * Math.sin(radOffset - increment),
  ]);
  for (let angle = radOffset; angle < Math.PI * 2 + radOffset - 0.01; angle += increment) {
    const p: Point = [
      offsetOpt(offsetAmount, o) + cx + rx * Math.cos(angle),
      offsetOpt(offsetAmount, o) + cy + ry * Math.sin(angle),
    ];
    corePoints.push(p);
    allPoints.push(p);
  }
  allPoints.push([
    offsetOpt(offsetAmount, o) + cx + rx * Math.cos(radOffset + Math.PI * 2 + overlap * 0.5),
    offsetOpt(offsetAmount, o) + cy + ry * Math.sin(radOffset + Math.PI * 2 + overlap * 0.5),
  ]);
  allPoints.push([
    offsetOpt(offsetAmount, o) + cx + 0.98 * rx * Math.cos(radOffset + overlap),
    offsetOpt(offsetAmount, o) + cy + 0.98 * ry * Math.sin(radOffset + overlap),
  ]);
  allPoints.push([
    offsetOpt(offsetAmount, o) + cx + 0.9 * rx * Math.cos(radOffset + overlap * 0.5),
    offsetOpt(offsetAmount, o) + cy + 0.9 * ry * Math.sin(radOffset + overlap * 0.5),
  ]);
  return { corePoints, allPoints };
}

export function ellipse(
  x: number,
  y: number,
  width: number,
  height: number,
  options: RoughOptions = {},
): Drawable {
  const o = resolveOptions(options);
  const { increment, rx, ry } = ellipseParams(width, height, o);
  const cx = x + width / 2;
  const cy = y + height / 2;

  const overlap = increment * offset(0.1, offset(0.4, 1, o), o);
  const { corePoints, allPoints } = computeEllipsePoints(increment, cx, cy, rx, ry, 1, overlap, o);
  const ops = curveOps(allPoints, o, { controlEnds: true });
  if (!o.disableMultiStroke) {
    const second = computeEllipsePoints(increment, cx, cy, rx, ry, 1.5, 0, o);
    ops.push(...curveOps(second.allPoints, o, { controlEnds: true }));
  }

  const sets: OpSet[] = [];
  const fill = buildFill([corePoints], o);
  if (fill) sets.push(fill);
  sets.push({ type: "path", ops });
  return { shape: "ellipse", sets, options: o };
}

/** Smooth open curve through the given points (used for lines/arrows/freedraw). */
export function curve(points: Point[], options: RoughOptions = {}): Drawable {
  const o = resolveOptions(options);
  const ops = curveWithOffset(points, 1 * (1 + o.roughness * 0.2), o);
  if (!o.disableMultiStroke) {
    ops.push(...curveWithOffset(points, 1.5 * (1 + o.roughness * 0.22), o));
  }
  return { shape: "curve", sets: [{ type: "path", ops }], options: o };
}

/** Closed smooth curve — a curve plus a fill computed from its own outline. */
export function closedCurve(points: Point[], options: RoughOptions = {}): Drawable {
  const o = resolveOptions(options);
  const sets: OpSet[] = [];
  const fill = buildFill([points], o);
  if (fill) sets.push(fill);
  const jitter = 1 + o.roughness * 0.4;
  const ops = curveWithOffset(points, jitter, o, { closed: true });
  if (!o.disableMultiStroke) {
    ops.push(...curveWithOffset(points, jitter * 1.4, o, { closed: true }));
  }
  sets.push({ type: "path", ops });
  return { shape: "closedCurve", sets, options: o };
}
