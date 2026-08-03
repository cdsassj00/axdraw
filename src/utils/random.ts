/**
 * Deterministic pseudo-random helpers.
 *
 * Every element carries a `seed`, so its hand-drawn geometry is stable across
 * re-renders, exports and reloads: the same seed always yields the same wobble.
 */

/** Fast, well-distributed 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_SEED = 2 ** 31 - 1;

/** Seed for a freshly created element. */
export function randomSeed(): number {
  return Math.floor(Math.random() * MAX_SEED);
}

/** Short, collision-resistant element id. */
export function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
