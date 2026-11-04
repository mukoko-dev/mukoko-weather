/**
 * Random numbers for the 2D weather effects (iPhone and iPad, where WebGL is
 * not used: see `backdropMode`).
 *
 * The effects are random on purpose: nothing is a tile that repeats, and every
 * particle that leaves the region comes back with a new random position, speed,
 * size and opacity, so the sky never settles into a loop. In the browser the
 * generator is `Math.random` (a different sky on every visit); the tests pass a
 * seeded one, so what they check is the algorithm and not luck.
 */

/** A source of numbers in [0, 1). */
export type Rng = () => number;

/** A small seeded generator (mulberry32): the same numbers for the same seed. */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A number in [min, max). */
export function between(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/**
 * `count` points in a `w` x `h` box that look scattered, not clumped.
 *
 * Mitchell's best-candidate algorithm: for each new point, draw `tries` random
 * candidates and keep the one farthest from every point chosen so far. Pure
 * random placement leaves gaps and clusters (it looks wrong in a sky: a clump of
 * stars or flakes reads as a pattern); this gives an even but still irregular
 * spread. `tries` of 6 is enough; more is slower and looks more regular.
 */
export function bestCandidate(
  count: number,
  w: number,
  h: number,
  rng: Rng,
  tries = 6,
): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    let best = { x: rng() * w, y: rng() * h };
    if (points.length > 0) {
      let bestDist = -1;
      for (let k = 0; k < tries; k++) {
        const c = { x: rng() * w, y: rng() * h };
        let nearest = Infinity;
        for (const p of points) {
          const d = (p.x - c.x) ** 2 + (p.y - c.y) ** 2;
          if (d < nearest) nearest = d;
        }
        if (nearest > bestDist) {
          bestDist = nearest;
          best = c;
        }
      }
    }
    points.push(best);
  }
  return points;
}

/** Clamp `n` into [min, max]. */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
