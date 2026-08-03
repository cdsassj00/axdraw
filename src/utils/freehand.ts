/**
 * Pressure-sensitive freehand stroke outlines.
 *
 * A pen stroke is not a stroked polyline — it is a *filled outline* whose width
 * varies with speed/pressure and tapers at both ends. That is what gives the
 * freedraw tool its ink-like feel. Implemented in the spirit of
 * `perfect-freehand`: smooth the input, walk it once, and emit the left and
 * right banks of the ribbon.
 */

export type InputPoint = [number, number] | [number, number, number];
export type Vec = [number, number];

const RATE_OF_PRESSURE_CHANGE = 0.275;
const FIXED_PI = Math.PI + 0.0001;

const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]];
const mul = (a: Vec, n: number): Vec => [a[0] * n, a[1] * n];
const per = (a: Vec): Vec => [a[1], -a[0]];
const neg = (a: Vec): Vec => [-a[0], -a[1]];
const dpr = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1];
const dist2 = (a: Vec, b: Vec): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const dist = (a: Vec, b: Vec): number => Math.hypot(a[1] - b[1], a[0] - b[0]);
const isEqual = (a: Vec, b: Vec): boolean => a[0] === b[0] && a[1] === b[1];
const lrp = (a: Vec, b: Vec, t: number): Vec => add(a, mul(sub(b, a), t));
const prj = (a: Vec, b: Vec, c: number): Vec => add(a, mul(b, c));

function uni(a: Vec): Vec {
  const length = Math.hypot(a[0], a[1]) || 1;
  return [a[0] / length, a[1] / length];
}

function rotAround(a: Vec, c: Vec, r: number): Vec {
  const s = Math.sin(r);
  const co = Math.cos(r);
  const px = a[0] - c[0];
  const py = a[1] - c[1];
  return [px * co - py * s + c[0], px * s + py * co + c[1]];
}

export interface StrokeOptions {
  size?: number;
  thinning?: number;
  smoothing?: number;
  streamline?: number;
  simulatePressure?: boolean;
  easing?: (t: number) => number;
  start?: { cap?: boolean; taper?: number | boolean; easing?: (t: number) => number };
  end?: { cap?: boolean; taper?: number | boolean; easing?: (t: number) => number };
  last?: boolean;
}

interface StrokePoint {
  point: Vec;
  pressure: number;
  vector: Vec;
  distance: number;
  runningLength: number;
}

function getStrokeRadius(
  size: number,
  thinning: number,
  pressure: number,
  easing: (t: number) => number,
): number {
  return size * easing(0.5 - thinning * (0.5 - pressure));
}

export function getStrokePoints(points: InputPoint[], options: StrokeOptions = {}): StrokePoint[] {
  const { streamline = 0.5, size = 16, last: isComplete = false } = options;
  if (points.length === 0) return [];

  const t = 0.15 + (1 - streamline) * 0.85;
  let pts: InputPoint[] = points.map((p) => [p[0], p[1], p[2] ?? 0.5] as InputPoint);
  if (pts.length === 1) {
    pts = [pts[0], [pts[0][0] + 1, pts[0][1] + 1, pts[0][2] ?? 0.5]];
  }

  const strokePoints: StrokePoint[] = [
    {
      point: [pts[0][0], pts[0][1]],
      pressure: (pts[0][2] ?? -1) >= 0 ? (pts[0][2] as number) : 0.25,
      vector: [1, 1],
      distance: 0,
      runningLength: 0,
    },
  ];

  let hasReachedMinimumLength = false;
  let runningLength = 0;
  let prev = strokePoints[0];
  const maxIndex = pts.length - 1;

  for (let i = 1; i < pts.length; i++) {
    const raw: Vec = [pts[i][0], pts[i][1]];
    const point = isComplete && i === maxIndex ? raw : lrp(prev.point, raw, t);
    if (isEqual(prev.point, point)) continue;

    const distance = dist(point, prev.point);
    runningLength += distance;
    if (i < maxIndex && !hasReachedMinimumLength) {
      if (runningLength < size) continue;
      hasReachedMinimumLength = true;
    }

    prev = {
      point,
      pressure: (pts[i][2] ?? -1) >= 0 ? (pts[i][2] as number) : 0.5,
      vector: uni(sub(prev.point, point)),
      distance,
      runningLength,
    };
    strokePoints.push(prev);
  }

  strokePoints[0].vector = strokePoints[1]?.vector ?? [0, 0];
  return strokePoints;
}

export function getStrokeOutlinePoints(
  points: StrokePoint[],
  options: StrokeOptions = {},
): Vec[] {
  const {
    size = 16,
    smoothing = 0.5,
    thinning = 0.5,
    simulatePressure = true,
    easing = (t: number) => t,
    start = {},
    end = {},
    last: isComplete = false,
  } = options;

  const { cap: capStart = true, taper: taperStart = 0, easing: taperStartEase = (t: number) => t * (2 - t) } = start;
  const { cap: capEnd = true, taper: taperEnd = 0, easing: taperEndEase = (t: number) => --t * t * t + 1 } = end;

  if (points.length === 0 || size <= 0) return [];

  const totalLength = points[points.length - 1].runningLength;
  const taperStartValue = taperStart === false ? 0 : taperStart === true ? Math.max(size, totalLength) : (taperStart as number);
  const taperEndValue = taperEnd === false ? 0 : taperEnd === true ? Math.max(size, totalLength) : (taperEnd as number);

  const minDistance = (size * smoothing) ** 2;
  const leftPts: Vec[] = [];
  const rightPts: Vec[] = [];

  let prevPressure = points.slice(0, 10).reduce((acc, curr) => {
    let pressure = curr.pressure;
    if (simulatePressure) {
      const sp = Math.min(1, curr.distance / size);
      const rp = Math.min(1, 1 - sp);
      pressure = Math.min(1, acc + (rp - acc) * (sp * RATE_OF_PRESSURE_CHANGE));
    }
    return (acc + pressure) / 2;
  }, points[0].pressure);

  let radius = getStrokeRadius(size, thinning, points[points.length - 1].pressure, easing);
  let firstRadius: number | undefined;
  let prevVector = points[0].vector;
  let pl = points[0].point;
  let pr = pl;
  let tl = pl;
  let tr = pr;
  let isPrevPointSharpCorner = false;

  for (let i = 0; i < points.length; i++) {
    let { pressure } = points[i];
    const { point, vector, distance, runningLength } = points[i];

    // Drop the last few points; they tend to jitter as the pointer lifts.
    if (i < points.length - 1 && totalLength - runningLength < 3) continue;

    if (thinning) {
      if (simulatePressure) {
        const sp = Math.min(1, distance / size);
        const rp = Math.min(1, 1 - sp);
        pressure = Math.min(1, prevPressure + (rp - prevPressure) * (sp * RATE_OF_PRESSURE_CHANGE));
      }
      radius = getStrokeRadius(size, thinning, pressure, easing);
    } else {
      radius = size / 2;
    }
    if (firstRadius === undefined) firstRadius = radius;

    const ts = runningLength < taperStartValue ? taperStartEase(runningLength / taperStartValue) : 1;
    const te = totalLength - runningLength < taperEndValue ? taperEndEase((totalLength - runningLength) / taperEndValue) : 1;
    radius = Math.max(0.01, radius * Math.min(ts, te));

    const nextVector = (i < points.length - 1 ? points[i + 1] : points[i]).vector;
    const nextDpr = i < points.length - 1 ? dpr(vector, nextVector) : 1;
    const prevDpr = dpr(vector, prevVector);

    const isPointSharpCorner = prevDpr < 0 && !isPrevPointSharpCorner;
    const isNextPointSharpCorner = nextDpr < 0;

    if (isPointSharpCorner || isNextPointSharpCorner) {
      // Round off the corner by fanning points around the vertex.
      const offset = mul(per(prevVector), radius);
      for (let step = 1 / 13, t = 0; t <= 1; t += step) {
        tl = rotAround(sub(point, offset), point, FIXED_PI * t);
        leftPts.push(tl);
        tr = rotAround(add(point, offset), point, FIXED_PI * -t);
        rightPts.push(tr);
      }
      pl = tl;
      pr = tr;
      if (isNextPointSharpCorner) isPrevPointSharpCorner = true;
      continue;
    }

    isPrevPointSharpCorner = false;

    if (i === points.length - 1) {
      const offset = mul(per(vector), radius);
      leftPts.push(sub(point, offset));
      rightPts.push(add(point, offset));
      continue;
    }

    const offset = mul(per(lrp(nextVector, vector, nextDpr)), radius);
    tl = sub(point, offset);
    if (i <= 1 || dist2(pl, tl) > minDistance) {
      leftPts.push(tl);
      pl = tl;
    }
    tr = add(point, offset);
    if (i <= 1 || dist2(pr, tr) > minDistance) {
      rightPts.push(tr);
      pr = tr;
    }

    prevPressure = pressure;
    prevVector = vector;
  }

  const firstPoint = points[0].point;
  const lastPoint = points.length > 1 ? points[points.length - 1].point : add(points[0].point, [1, 1]);
  const startCap: Vec[] = [];
  const endCap: Vec[] = [];

  if (points.length === 1) {
    if (!(taperStartValue || taperEndValue) || isComplete) {
      const start2 = prj(firstPoint, uni(per(sub(firstPoint, lastPoint))), -(firstRadius || radius));
      const dotPts: Vec[] = [];
      for (let step = 1 / 13, t = step; t <= 1; t += step) {
        dotPts.push(rotAround(start2, firstPoint, FIXED_PI * 2 * t));
      }
      return dotPts;
    }
  } else {
    if (!(taperStartValue > 0)) {
      if (capStart) {
        for (let step = 1 / 13, t = step; t <= 1; t += step) {
          startCap.push(rotAround(rightPts[0], firstPoint, FIXED_PI * t));
        }
      } else {
        const cornersVector = sub(leftPts[0], rightPts[0]);
        const offsetA = mul(cornersVector, 0.5);
        const offsetB = mul(cornersVector, 0.51);
        startCap.push(
          sub(firstPoint, offsetA),
          sub(firstPoint, offsetB),
          add(firstPoint, offsetB),
          add(firstPoint, offsetA),
        );
      }
    }

    const direction = per(neg(points[points.length - 1].vector));
    if (taperEndValue > 0) {
      endCap.push(lastPoint);
    } else if (capEnd) {
      const start2 = prj(lastPoint, direction, radius);
      for (let step = 1 / 29, t = step; t < 1; t += step) {
        endCap.push(rotAround(start2, lastPoint, FIXED_PI * 3 * t));
      }
    } else {
      endCap.push(
        add(lastPoint, mul(direction, radius)),
        add(lastPoint, mul(direction, radius * 0.99)),
        sub(lastPoint, mul(direction, radius * 0.99)),
        sub(lastPoint, mul(direction, radius)),
      );
    }
  }

  return leftPts.concat(endCap, rightPts.reverse(), startCap);
}

export function getStroke(points: InputPoint[], options: StrokeOptions = {}): Vec[] {
  return getStrokeOutlinePoints(getStrokePoints(points, options), options);
}

/** Quadratic-smoothed SVG path for a closed outline produced by `getStroke`. */
export function getSvgPathFromStroke(points: Vec[], closed = true): string {
  const len = points.length;
  if (len < 4) return "";
  const average = (a: number, b: number) => (a + b) / 2;
  let a = points[0];
  let b = points[1];
  const c = points[2];
  let result = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(
    2,
  )} ${average(b[0], c[0]).toFixed(2)},${average(b[1], c[1]).toFixed(2)} T`;

  for (let i = 2, max = len - 1; i < max; i++) {
    a = points[i];
    b = points[i + 1];
    result += `${average(a[0], b[0]).toFixed(2)},${average(a[1], b[1]).toFixed(2)} `;
  }
  if (closed) result += "Z";
  return result;
}
