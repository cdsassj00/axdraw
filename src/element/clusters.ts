/**
 * Grouping elements by where they sit on the canvas.
 *
 * A big board — a lecture worked through over an hour, or a shared room where
 * several people draw in their own corner — ends up as islands of work
 * separated by empty space. "Zoom to fit" is the wrong tool for that: fitting
 * everything means fitting the emptiness too, and at 1000+ elements spread over
 * a few hundred thousand pixels the result is a screen of specks. What you
 * actually want is to jump between the islands.
 */

import type { AxElement } from "../types";

export interface Cluster {
  elements: AxElement[];
  bounds: { x1: number; y1: number; x2: number; y2: number };
}

/**
 * Elements whose geometry can be reasoned about. Anything non-finite is left
 * out rather than dragging a cluster's bounds to infinity.
 */
function measurable(elements: readonly AxElement[]): AxElement[] {
  return elements.filter(
    (element) =>
      !element.isDeleted &&
      Number.isFinite(element.x) &&
      Number.isFinite(element.y) &&
      Number.isFinite(element.width) &&
      Number.isFinite(element.height),
  );
}

function boundsOf(elements: readonly AxElement[]): Cluster["bounds"] {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const element of elements) {
    x1 = Math.min(x1, element.x);
    y1 = Math.min(y1, element.y);
    x2 = Math.max(x2, element.x + element.width);
    y2 = Math.max(y2, element.y + element.height);
  }
  return { x1, y1, x2, y2 };
}

/**
 * Group elements into islands of work.
 *
 * Buckets centres into a grid and merges touching buckets, which is linear in
 * the number of elements — comparing every pair would be a million comparisons
 * on a board this size, run every time the list is opened.
 *
 * `gap` is how far apart two elements must be to count as separate work.
 * Clusters come back largest first: on a board you have lost your place in,
 * the biggest concentration is almost always the one you are looking for.
 */
export function findClusters(elements: readonly AxElement[], gap = 600): Cluster[] {
  const usable = measurable(elements);
  if (!usable.length) return [];

  const buckets = new Map<string, { cx: number; cy: number; elements: AxElement[] }>();
  for (const element of usable) {
    const cx = Math.floor((element.x + element.width / 2) / gap);
    const cy = Math.floor((element.y + element.height / 2) / gap);
    const key = `${cx},${cy}`;
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = { cx, cy, elements: [] }));
    bucket.elements.push(element);
  }

  const visited = new Set<string>();
  const clusters: Cluster[] = [];
  for (const [key, bucket] of buckets) {
    if (visited.has(key)) continue;
    visited.add(key);
    const stack = [bucket];
    const collected: AxElement[] = [];
    while (stack.length) {
      const current = stack.pop()!;
      collected.push(...current.elements);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const neighbour = `${current.cx + dx},${current.cy + dy}`;
          if (visited.has(neighbour)) continue;
          const found = buckets.get(neighbour);
          if (!found) continue;
          visited.add(neighbour);
          stack.push(found);
        }
      }
    }
    clusters.push({ elements: collected, bounds: boundsOf(collected) });
  }

  return clusters.sort((a, b) => b.elements.length - a.elements.length);
}
