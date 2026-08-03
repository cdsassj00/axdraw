/**
 * Polygon fill patterns (hachure, cross-hatch, zigzag, dots, dashes).
 *
 * All patterns are built on top of a scanline hachure: we rotate the polygon so
 * the requested hachure angle becomes horizontal, sweep horizontal lines
 * through it with an active-edge table, then rotate the resulting segments
 * back.
 */

import type { Point } from "./types";

interface EdgeEntry {
  ymin: number;
  ymax: number;
  x: number;
  islope: number;
}

export type Segment = [Point, Point];

function rotatePoints(points: Point[], center: Point, degrees: number): Point[] {
  if (!points.length) return points;
  const angle = (Math.PI / 180) * degrees;
  const [cx, cy] = center;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return points.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos] as Point;
  });
}

function rotateSegments(
  segments: Segment[],
  center: Point,
  degrees: number,
): Segment[] {
  return segments.map((seg) => {
    const [p1, p2] = rotatePoints(seg, center, degrees);
    return [p1, p2] as Segment;
  });
}

/** Axis-aligned scanline fill of one or more (already rotated) polygons. */
function straightHachureLines(polygons: Point[][], stepOffset: number): Segment[] {
  const lines: Segment[] = [];
  const closed: Point[][] = [];
  for (const polygon of polygons) {
    const vertices = polygon.slice();
    if (vertices.length < 3) continue;
    const first = vertices[0];
    const last = vertices[vertices.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      vertices.push([first[0], first[1]]);
    }
    closed.push(vertices);
  }
  if (!closed.length) return lines;

  const edges: EdgeEntry[] = [];
  for (const vertices of closed) {
    for (let i = 0; i < vertices.length - 1; i++) {
      const p1 = vertices[i];
      const p2 = vertices[i + 1];
      if (p1[1] === p2[1]) continue;
      const ymin = Math.min(p1[1], p2[1]);
      edges.push({
        ymin,
        ymax: Math.max(p1[1], p2[1]),
        x: ymin === p1[1] ? p1[0] : p2[0],
        islope: (p2[0] - p1[0]) / (p2[1] - p1[1]),
      });
    }
  }
  if (!edges.length) return lines;

  edges.sort((a, b) => (a.ymin !== b.ymin ? a.ymin - b.ymin : a.x - b.x));

  let active: { s: number; edge: EdgeEntry }[] = [];
  let y = edges[0].ymin;
  let guard = 0;
  while ((active.length || edges.length) && guard++ < 20000) {
    if (edges.length) {
      let index = -1;
      for (let i = 0; i < edges.length; i++) {
        if (edges[i].ymin > y) break;
        index = i;
      }
      const removed = edges.splice(0, index + 1);
      for (const edge of removed) active.push({ s: y, edge });
    }
    active = active.filter((entry) => entry.edge.ymax > y);
    active.sort((a, b) => a.edge.x - b.edge.x);

    for (let i = 0; i + 1 < active.length; i += 2) {
      const a = active[i].edge;
      const b = active[i + 1].edge;
      if (Math.abs(b.x - a.x) < 0.0001) continue;
      lines.push([
        [a.x, y],
        [b.x, y],
      ]);
    }

    y += stepOffset;
    for (const entry of active) {
      entry.edge.x += stepOffset * entry.edge.islope;
    }
  }
  return lines;
}

export interface HachureConfig {
  hachureAngle: number;
  hachureGap: number;
  strokeWidth: number;
  roughness: number;
  random: () => number;
}

/** Hachure lines for a polygon, honouring the configured angle and gap. */
export function polygonHachureLines(
  polygons: Point[][],
  config: HachureConfig,
): Segment[] {
  const angle = config.hachureAngle + 90;
  let gap = config.hachureGap;
  if (gap < 0) gap = config.strokeWidth * 4;
  gap = Math.max(gap, 0.1);

  // A little irregularity keeps dense fills from looking machine-made.
  let stepOffset = gap;
  if (config.roughness >= 1 && config.random() > 0.7) {
    stepOffset = gap * (1 + config.random() * 0.15);
  }

  const flat = polygons.flat();
  if (!flat.length) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of flat) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const center: Point = [(minX + maxX) / 2, (minY + maxY) / 2];

  const rotated = polygons.map((p) => rotatePoints(p, center, -angle));
  const lines = straightHachureLines(rotated, stepOffset);
  return rotateSegments(lines, center, angle);
}

/**
 * Connect hachure lines end-to-end so the fill reads as one continuous stroke
 * that folds back on itself.
 */
export function zigzagLines(lines: Segment[]): Segment[] {
  const result: Segment[] = [];
  let previousEnd: Point | null = null;
  for (let i = 0; i < lines.length; i++) {
    const [a, b] = lines[i];
    // Alternate the sweep direction so consecutive lines share an endpoint.
    const start = i % 2 === 0 ? a : b;
    const end = i % 2 === 0 ? b : a;
    if (previousEnd) result.push([previousEnd, start]);
    result.push([start, end]);
    previousEnd = end;
  }
  return result;
}

/** Sample dot centres along hachure lines, with a touch of jitter. */
export function dotsAlongLines(
  lines: Segment[],
  gap: number,
  random: () => number,
): Point[] {
  const dots: Point[] = [];
  const step = Math.max(gap, 0.5);
  for (const [start, end] of lines) {
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const length = Math.hypot(dx, dy);
    if (length <= 0) continue;
    const ux = dx / length;
    const uy = dy / length;
    const count = Math.max(1, Math.round(length / step));
    const offset = (length - (count - 1) * step) / 2;
    for (let i = 0; i < count; i++) {
      const d = offset + i * step;
      const jitterX = (random() - 0.5) * step * 0.4;
      const jitterY = (random() - 0.5) * step * 0.4;
      dots.push([start[0] + ux * d + jitterX, start[1] + uy * d + jitterY]);
    }
  }
  return dots;
}

/** Split hachure lines into dashes. */
export function dashedLines(
  lines: Segment[],
  dashOffset: number,
  dashGap: number,
): Segment[] {
  const result: Segment[] = [];
  for (const [start, end] of lines) {
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const length = Math.hypot(dx, dy);
    if (length <= 0) continue;
    const count = Math.floor(length / (dashOffset + dashGap));
    const lineOffset = (length + dashGap - count * (dashOffset + dashGap)) / 2;
    const ux = dx / length;
    const uy = dy / length;
    for (let i = 0; i < count; i++) {
      const s = lineOffset + i * (dashOffset + dashGap);
      const e = s + dashOffset;
      result.push([
        [start[0] + ux * s, start[1] + uy * s],
        [start[0] + ux * e, start[1] + uy * e],
      ]);
    }
  }
  return result;
}
