/**
 * Shape recognition — "draw it roughly, get it straight".
 *
 * A finished freehand stroke is analysed and, when it clearly resembles a
 * primitive, replaced by a clean element: rectangle, square, ellipse, circle,
 * diamond, triangle, straight line or arrow. Rotated rectangles are recovered
 * with a minimum-area rectangle fit, so a tilted box stays tilted instead of
 * snapping to the axes.
 *
 * The classifier is deliberately conservative: if the stroke does not clearly
 * match anything, it is left as freehand.
 */

export type Pt = [number, number];

export interface RecognizedRect {
  type: "rectangle" | "diamond" | "ellipse";
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
}

export interface RecognizedPath {
  type: "line" | "arrow" | "triangle";
  /** Absolute scene points. */
  points: Pt[];
  closed: boolean;
}

export type Recognized = RecognizedRect | RecognizedPath;

/* ------------------------------------------------------------------ *
 * Small geometry helpers
 * ------------------------------------------------------------------ */

const distance = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

function pathLength(points: Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}

function boundingBox(points: Pt[]) {
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
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function perpendicularDistance(point: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(point, a);
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSq));
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy));
}

/** Ramer–Douglas–Peucker simplification. */
function simplify(points: Pt[], epsilon: number): Pt[] {
  if (points.length < 3) return points.slice();
  let maxDistance = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], points[0], points[points.length - 1]);
    if (d > maxDistance) {
      maxDistance = d;
      index = i;
    }
  }
  if (maxDistance <= epsilon) return [points[0], points[points.length - 1]];
  const left = simplify(points.slice(0, index + 1), epsilon);
  const right = simplify(points.slice(index), epsilon);
  return [...left.slice(0, -1), ...right];
}

/** Resample a stroke to evenly spaced points — makes the metrics stable. */
function resample(points: Pt[], count: number): Pt[] {
  const total = pathLength(points);
  if (total === 0 || points.length < 2) return points.slice();
  const interval = total / (count - 1);
  const result: Pt[] = [points[0]];
  let accumulated = 0;
  let previous = points[0];

  for (let i = 1; i < points.length; ) {
    const current = points[i];
    const segment = distance(previous, current);
    if (accumulated + segment >= interval) {
      const ratio = (interval - accumulated) / segment;
      const next: Pt = [
        previous[0] + ratio * (current[0] - previous[0]),
        previous[1] + ratio * (current[1] - previous[1]),
      ];
      result.push(next);
      previous = next;
      accumulated = 0;
    } else {
      accumulated += segment;
      previous = current;
      i++;
    }
  }
  while (result.length < count) result.push(points[points.length - 1]);
  return result.slice(0, count);
}

function polygonArea(points: Pt[]): number {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += (points[j][0] + points[i][0]) * (points[j][1] - points[i][1]);
  }
  return Math.abs(area / 2);
}

/** Andrew's monotone chain convex hull. */
function convexHull(points: Pt[]): Pt[] {
  const sorted = points.slice().sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  if (sorted.length < 3) return sorted;
  const cross = (o: Pt, a: Pt, b: Pt) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Pt[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: Pt[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const point = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Minimum-area enclosing rectangle via rotating calipers over the hull. */
function minAreaRect(points: Pt[]): { cx: number; cy: number; width: number; height: number; angle: number } {
  const hull = convexHull(points);
  if (hull.length < 3) {
    const box = boundingBox(points);
    return {
      cx: (box.minX + box.maxX) / 2,
      cy: (box.minY + box.maxY) / 2,
      width: box.width,
      height: box.height,
      angle: 0,
    };
  }

  let best = { area: Infinity, cx: 0, cy: 0, width: 0, height: 0, angle: 0 };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const edgeAngle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const cos = Math.cos(-edgeAngle);
    const sin = Math.sin(-edgeAngle);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of hull) {
      const rx = x * cos - y * sin;
      const ry = x * sin + y * cos;
      minX = Math.min(minX, rx);
      maxX = Math.max(maxX, rx);
      minY = Math.min(minY, ry);
      maxY = Math.max(maxY, ry);
    }
    const width = maxX - minX;
    const height = maxY - minY;
    const area = width * height;
    if (area < best.area) {
      // Rotate the rectangle centre back into scene space.
      const cxr = (minX + maxX) / 2;
      const cyr = (minY + maxY) / 2;
      const back = Math.cos(edgeAngle);
      const backSin = Math.sin(edgeAngle);
      best = {
        area,
        cx: cxr * back - cyr * backSin,
        cy: cxr * backSin + cyr * back,
        width,
        height,
        angle: edgeAngle,
      };
    }
  }
  return best;
}

/** Normalise a rectangle angle into (-45°, 45°] by swapping the sides. */
function normalizeRectAngle(rect: { width: number; height: number; angle: number }) {
  let { width, height, angle } = rect;
  const quarter = Math.PI / 2;
  while (angle > Math.PI / 4) {
    angle -= quarter;
    [width, height] = [height, width];
  }
  while (angle <= -Math.PI / 4) {
    angle += quarter;
    [width, height] = [height, width];
  }
  return { width, height, angle };
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

export interface RecognizeOptions {
  /** Snap near-square boxes to squares and near-circles to circles. */
  snapEqualSides?: boolean;
  /** Snap a nearly axis-aligned result to exactly 0°. */
  angleTolerance?: number;
}

const DEFAULTS: Required<RecognizeOptions> = {
  snapEqualSides: true,
  angleTolerance: (8 * Math.PI) / 180,
};

/** Count direction changes sharper than ~50° along a simplified polyline. */
function countCorners(points: Pt[], closed: boolean): number {
  const list = closed ? [...points, points[0], points[1]] : points;
  let corners = 0;
  for (let i = 1; i < list.length - 1; i++) {
    const a = list[i - 1];
    const b = list[i];
    const c = list[i + 1];
    const v1 = [b[0] - a[0], b[1] - a[1]];
    const v2 = [c[0] - b[0], c[1] - b[1]];
    const len1 = Math.hypot(v1[0], v1[1]);
    const len2 = Math.hypot(v2[0], v2[1]);
    if (len1 < 1e-6 || len2 < 1e-6) continue;
    const dot = (v1[0] * v2[0] + v1[1] * v2[1]) / (len1 * len2);
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (angle > (50 * Math.PI) / 180) corners++;
  }
  return corners;
}

/** How well the stroke hugs the outline of the given rectangle. */
function rectangleFitError(points: Pt[], rect: Frame): number {
  const cos = Math.cos(-rect.angle);
  const sin = Math.sin(-rect.angle);
  const halfW = rect.width / 2;
  const halfH = rect.height / 2;
  const cxr = rect.cx * cos - rect.cy * sin;
  const cyr = rect.cx * sin + rect.cy * cos;
  let total = 0;
  for (const [x, y] of points) {
    const rx = x * cos - y * sin - cxr;
    const ry = x * sin + y * cos - cyr;
    // Distance to the rectangle border (points are expected to sit on it).
    const dx = halfW - Math.abs(rx);
    const dy = halfH - Math.abs(ry);
    total += Math.abs(Math.min(dx, dy));
  }
  return total / points.length / Math.max(halfW, halfH);
}

/** How well the stroke hugs the ellipse inscribed in the given rectangle. */
function ellipseFitError(points: Pt[], rect: Frame): number {
  const cos = Math.cos(-rect.angle);
  const sin = Math.sin(-rect.angle);
  const rx = Math.max(rect.width / 2, 1e-6);
  const ry = Math.max(rect.height / 2, 1e-6);
  const cxr = rect.cx * cos - rect.cy * sin;
  const cyr = rect.cx * sin + rect.cy * cos;
  let total = 0;
  for (const [x, y] of points) {
    const px = (x * cos - y * sin - cxr) / rx;
    const py = (x * sin + y * cos - cyr) / ry;
    total += Math.abs(Math.hypot(px, py) - 1);
  }
  return total / points.length;
}

/** Diamond fit: |x|/a + |y|/b should equal 1 on the outline. */
function diamondFitError(points: Pt[], rect: Frame): number {
  const cos = Math.cos(-rect.angle);
  const sin = Math.sin(-rect.angle);
  const rx = Math.max(rect.width / 2, 1e-6);
  const ry = Math.max(rect.height / 2, 1e-6);
  const cxr = rect.cx * cos - rect.cy * sin;
  const cyr = rect.cx * sin + rect.cy * cos;
  let total = 0;
  for (const [x, y] of points) {
    const px = Math.abs(x * cos - y * sin - cxr) / rx;
    const py = Math.abs(x * sin + y * cos - cyr) / ry;
    total += Math.abs(px + py - 1);
  }
  return total / points.length;
}

/**
 * Detect a hand-drawn arrow: a straight shaft followed by a head drawn without
 * lifting the pen (tip → barb → tip → barb, in any of its common variants).
 * Returns the index of the tip in the simplified polyline, or -1.
 */
function findArrowTip(simplified: Pt[]): number {
  if (simplified.length < 4 || simplified.length > 8) return -1;

  // The tip is the point farthest from where the stroke began.
  const start = simplified[0];
  let tipIndex = 0;
  let shaftLength = 0;
  for (let i = 1; i < simplified.length; i++) {
    const d = distance(start, simplified[i]);
    if (d > shaftLength) {
      shaftLength = d;
      tipIndex = i;
    }
  }
  // There must be a head after the tip, and a shaft before it.
  if (tipIndex === 0 || tipIndex >= simplified.length - 1) return -1;
  if (shaftLength < 24) return -1;

  const tip = simplified[tipIndex];

  // The shaft has to be straight.
  for (let i = 1; i < tipIndex; i++) {
    if (perpendicularDistance(simplified[i], start, tip) > shaftLength * 0.12) return -1;
  }

  const dirX = (tip[0] - start[0]) / shaftLength;
  const dirY = (tip[1] - start[1]) / shaftLength;

  // Everything after the tip belongs to the head: short, and behind the tip.
  const head = simplified.slice(tipIndex + 1);
  if (head.length < 1 || head.length > 4) return -1;
  for (const point of head) {
    const dx = point[0] - tip[0];
    const dy = point[1] - tip[1];
    const d = Math.hypot(dx, dy);
    if (d > shaftLength * 0.5) return -1;
    // Points that come back to the tip are fine; the rest must trail behind it.
    if (d > shaftLength * 0.04 && dx * dirX + dy * dirY > d * 0.2) return -1;
  }
  return tipIndex;
}

interface Frame {
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
}

/**
 * Frame implied by the four corners of a quadrilateral sketch, with the axes
 * pointing at the corners. This is the frame a diamond lives in — its
 * minimum-area rectangle is aligned to its *sides* instead, which would make it
 * indistinguishable from a tilted rectangle.
 */
function frameFromQuadCorners(corners: Pt[]): Frame | null {
  if (corners.length !== 4) return null;
  const cx = (corners[0][0] + corners[1][0] + corners[2][0] + corners[3][0]) / 4;
  const cy = (corners[0][1] + corners[1][1] + corners[2][1] + corners[3][1]) / 4;

  const axisA = [(corners[0][0] - corners[2][0]) / 2, (corners[0][1] - corners[2][1]) / 2];
  const axisB = [(corners[1][0] - corners[3][0]) / 2, (corners[1][1] - corners[3][1]) / 2];
  const lenA = Math.hypot(axisA[0], axisA[1]);
  const lenB = Math.hypot(axisB[0], axisB[1]);
  if (lenA < 4 || lenB < 4) return null;

  // The two half-diagonals must be roughly perpendicular.
  const cos = Math.abs((axisA[0] * axisB[0] + axisA[1] * axisB[1]) / (lenA * lenB));
  if (cos > 0.3) return null;

  return {
    cx,
    cy,
    width: lenA * 2,
    height: lenB * 2,
    angle: Math.atan2(axisA[1], axisA[0]),
  };
}

/**
 * Classify a freehand stroke. `points` are absolute scene coordinates.
 * Returns `null` when the stroke should stay freehand.
 */
export function recognizeShape(points: Pt[], options: RecognizeOptions = {}): Recognized | null {
  const config = { ...DEFAULTS, ...options };
  if (points.length < 4) return null;

  const box = boundingBox(points);
  const diagonal = Math.hypot(box.width, box.height);
  const length = pathLength(points);
  if (diagonal < 16 || length < 24) return null;

  const resampled = resample(points, 64);
  const epsilon = Math.max(diagonal * 0.035, 2);
  const simplified = simplify(points, epsilon);

  const closingDistance = distance(points[0], points[points.length - 1]);
  const closed = closingDistance < diagonal * 0.28 && length > diagonal * 1.6;

  /* ---------------- open strokes: line / arrow ---------------- */
  if (!closed) {
    const start = points[0];
    const end = points[points.length - 1];
    const straightness = Math.max(
      ...resampled.map((point) => perpendicularDistance(point, start, end)),
    );

    const tipIndex = findArrowTip(simplified);
    if (tipIndex > 0) {
      const shaft = simplified.slice(0, tipIndex + 1);
      const shaftStraightness = Math.max(
        ...shaft.map((point) => perpendicularDistance(point, shaft[0], shaft[shaft.length - 1])),
      );
      if (shaftStraightness < pathLength(shaft) * 0.14) {
        return {
          type: "arrow",
          points: [shaft[0], shaft[shaft.length - 1]],
          closed: false,
        };
      }
    }

    if (straightness < Math.max(length * 0.045, 4)) {
      return { type: "line", points: [start, end], closed: false };
    }

    // A multi-segment polyline with clean corners (e.g. a flow connector).
    if (simplified.length >= 3 && simplified.length <= 5) {
      const cornerCount = countCorners(simplified, false);
      const segmentsStraight = simplified.every((_, index) => {
        if (index === 0) return true;
        return distance(simplified[index - 1], simplified[index]) > diagonal * 0.12;
      });
      if (cornerCount >= 1 && cornerCount <= 3 && segmentsStraight) {
        return { type: "line", points: simplified, closed: false };
      }
    }
    return null;
  }

  /* ---------------- closed strokes ---------------- */
  const closedPoints = resample([...points, points[0]], 72);
  const area = polygonArea(closedPoints);

  const simplifiedClosed = simplify([...points, points[0]], Math.max(diagonal * 0.05, 3));
  const cornerPoints = simplifiedClosed.slice(0, -1);
  const corners = countCorners(cornerPoints, true);

  // Two candidate frames: the minimum-area rectangle (right for rectangles,
  // tilted or not) and the corner-aligned frame (right for diamonds).
  const frames: Frame[] = [normalizeFrame(minAreaRect(closedPoints))];
  const quadCorners = simplify([...points, points[0]], Math.max(diagonal * 0.08, 4)).slice(0, -1);
  const quadFrame = frameFromQuadCorners(quadCorners);
  if (quadFrame) frames.push(normalizeFrame(quadFrame));

  interface Candidate {
    type: RecognizedRect["type"];
    error: number;
    frame: Frame;
  }

  let best: Candidate | null = null;
  const consider = (type: RecognizedRect["type"], error: number, frame: Frame, allowed: boolean) => {
    if (!allowed || error > 0.17) return;
    if (!best || error < best.error) best = { type, error, frame };
  };

  for (const frame of frames) {
    if (frame.width < 8 || frame.height < 8) continue;
    const extent = area / (frame.width * frame.height || 1);
    consider("rectangle", rectangleFitError(closedPoints, frame), frame, extent > 0.7 && corners <= 6);
    consider("ellipse", ellipseFitError(closedPoints, frame), frame, Math.abs(extent - Math.PI / 4) < 0.15);
    consider("diamond", diamondFitError(closedPoints, frame), frame, Math.abs(extent - 0.5) < 0.16 && corners <= 5);
  }

  // Triangle: three strong corners filling about half of the box.
  if (corners === 3) {
    const frame = frames[0];
    const extent = area / (frame.width * frame.height || 1);
    if (extent > 0.3 && extent < 0.7 && quadCorners.length === 3) {
      return { type: "triangle", points: quadCorners, closed: true };
    }
  }

  if (!best) {
    // A round-ish blob the strict tests rejected is still most likely a circle.
    const frame = frames[0];
    const extent = area / (frame.width * frame.height || 1);
    if (corners <= 2 && extent > 0.6 && ellipseFitError(closedPoints, frame) < 0.22) {
      best = { type: "ellipse", error: 0.22, frame };
    } else {
      return null;
    }
  }

  const winner = best as Candidate;
  let { width, height, angle } = winner.frame;
  if (Math.abs(angle) < config.angleTolerance) angle = 0;
  if (config.snapEqualSides) {
    const ratio = Math.min(width, height) / Math.max(width, height);
    if (ratio > 0.88) {
      const side = (width + height) / 2;
      width = side;
      height = side;
    }
  }
  return { type: winner.type, cx: winner.frame.cx, cy: winner.frame.cy, width, height, angle };
}

/**
 * The box the recogniser would fit a closed stroke into, whatever it decided
 * the stroke actually was.
 *
 * `recognizeShape` is deliberately conservative and returns null when nothing
 * scores well, which leaves an ambiguous scribble as freehand with no way to
 * say "no, that was a diamond". This exposes the frame on its own so the UI can
 * offer rectangle/ellipse/diamond over the same box — the geometry is already
 * computed, it was just being thrown away with the losing candidates.
 *
 * Returns null for strokes too open or too small to have a meaningful box.
 */
export function recognizeFrame(points: Pt[], options: RecognizeOptions = {}): Frame | null {
  const config = { ...DEFAULTS, ...options };
  if (points.length < 8) return null;

  const box = boundingBox(points);
  const diagonal = Math.hypot(box.width, box.height);
  if (diagonal < 16) return null;

  // Same closed-stroke test recognizeShape uses.
  const closingDistance = distance(points[0], points[points.length - 1]);
  const closed = closingDistance < diagonal * 0.28 && pathLength(points) > diagonal * 1.6;
  if (!closed) return null;

  const closedPoints = resample([...points, points[0]], 72);
  const frame = normalizeFrame(minAreaRect(closedPoints));
  if (frame.width < 8 || frame.height < 8) return null;

  let { width, height, angle } = frame;
  if (Math.abs(angle) < config.angleTolerance) angle = 0;
  if (config.snapEqualSides) {
    const ratio = Math.min(width, height) / Math.max(width, height);
    if (ratio > 0.88) {
      const side = (width + height) / 2;
      width = side;
      height = side;
    }
  }
  return { cx: frame.cx, cy: frame.cy, width, height, angle };
}

/** Bring a frame's angle into (-45°, 45°] by swapping its sides. */
function normalizeFrame(frame: Frame): Frame {
  const { width, height, angle } = normalizeRectAngle(frame);
  return { cx: frame.cx, cy: frame.cy, width, height, angle };
}
