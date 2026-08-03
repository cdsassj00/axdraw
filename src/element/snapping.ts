/** Object snapping: align edges and centres with nearby elements. */

import type { SnapLine } from "../scene/interactive";
import type { AxElement, Bounds, Point } from "../types";
import { getElementBounds } from "./bounds";

export interface SnapResult {
  dx: number;
  dy: number;
  lines: SnapLine[];
}

const NO_SNAP: SnapResult = { dx: 0, dy: 0, lines: [] };

interface Candidate {
  offset: number;
  /** Coordinate the guide is drawn at. */
  position: number;
  /** Bounds of the element we snapped to, for drawing the guide. */
  other: Bounds;
}

function pickBest(candidates: Candidate[], threshold: number): Candidate | null {
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (Math.abs(candidate.offset) > threshold) continue;
    if (!best || Math.abs(candidate.offset) < Math.abs(best.offset)) best = candidate;
  }
  return best;
}

/**
 * Snap `bounds` against every other element. `threshold` is in scene units, so
 * callers should divide their pixel threshold by the zoom level.
 */
export function computeSnap(
  bounds: Bounds,
  elements: readonly AxElement[],
  excludeIds: Set<string>,
  threshold: number,
): SnapResult {
  if (threshold <= 0) return NO_SNAP;

  const targets: Bounds[] = [];
  for (const element of elements) {
    if (element.isDeleted || excludeIds.has(element.id)) continue;
    targets.push(getElementBounds(element));
  }
  if (!targets.length) return NO_SNAP;

  const movingX = [bounds.x1, (bounds.x1 + bounds.x2) / 2, bounds.x2];
  const movingY = [bounds.y1, (bounds.y1 + bounds.y2) / 2, bounds.y2];

  const xCandidates: Candidate[] = [];
  const yCandidates: Candidate[] = [];

  for (const other of targets) {
    const otherX = [other.x1, (other.x1 + other.x2) / 2, other.x2];
    const otherY = [other.y1, (other.y1 + other.y2) / 2, other.y2];
    for (const mx of movingX) {
      for (const ox of otherX) {
        xCandidates.push({ offset: ox - mx, position: ox, other });
      }
    }
    for (const my of movingY) {
      for (const oy of otherY) {
        yCandidates.push({ offset: oy - my, position: oy, other });
      }
    }
  }

  const bestX = pickBest(xCandidates, threshold);
  const bestY = pickBest(yCandidates, threshold);

  const lines: SnapLine[] = [];
  const dx = bestX?.offset ?? 0;
  const dy = bestY?.offset ?? 0;

  if (bestX) {
    const top = Math.min(bounds.y1 + dy, bestX.other.y1);
    const bottom = Math.max(bounds.y2 + dy, bestX.other.y2);
    lines.push({ from: { x: bestX.position, y: top }, to: { x: bestX.position, y: bottom } });
  }
  if (bestY) {
    const left = Math.min(bounds.x1 + dx, bestY.other.x1);
    const right = Math.max(bounds.x2 + dx, bestY.other.x2);
    lines.push({ from: { x: left, y: bestY.position }, to: { x: right, y: bestY.position } });
  }

  return { dx, dy, lines };
}

/**
 * Snap a single point (a dragged resize handle, a line endpoint) to the edges
 * and centres of nearby elements.
 */
export function snapPointToObjects(
  point: Point,
  elements: readonly AxElement[],
  excludeIds: Set<string>,
  threshold: number,
): { point: Point; lines: SnapLine[] } {
  if (threshold <= 0) return { point, lines: [] };

  let bestX: { offset: number; position: number; other: Bounds } | null = null;
  let bestY: { offset: number; position: number; other: Bounds } | null = null;

  for (const element of elements) {
    if (element.isDeleted || excludeIds.has(element.id)) continue;
    const other = getElementBounds(element);
    for (const x of [other.x1, (other.x1 + other.x2) / 2, other.x2]) {
      const offset = x - point.x;
      if (Math.abs(offset) <= threshold && (!bestX || Math.abs(offset) < Math.abs(bestX.offset))) {
        bestX = { offset, position: x, other };
      }
    }
    for (const y of [other.y1, (other.y1 + other.y2) / 2, other.y2]) {
      const offset = y - point.y;
      if (Math.abs(offset) <= threshold && (!bestY || Math.abs(offset) < Math.abs(bestY.offset))) {
        bestY = { offset, position: y, other };
      }
    }
  }

  const snapped: Point = {
    x: point.x + (bestX?.offset ?? 0),
    y: point.y + (bestY?.offset ?? 0),
  };
  const lines: SnapLine[] = [];
  if (bestX) {
    lines.push({
      from: { x: bestX.position, y: Math.min(snapped.y, bestX.other.y1) },
      to: { x: bestX.position, y: Math.max(snapped.y, bestX.other.y2) },
    });
  }
  if (bestY) {
    lines.push({
      from: { x: Math.min(snapped.x, bestY.other.x1), y: bestY.position },
      to: { x: Math.max(snapped.x, bestY.other.x2), y: bestY.position },
    });
  }
  return { point: snapped, lines };
}
