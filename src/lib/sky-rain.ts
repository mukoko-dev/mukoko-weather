/**
 * The raindrops of the CSS-only rain sky (`SkyRain`, used where the Three.js
 * scene is not: iPhone and iPad, see `backdropMode`).
 *
 * One small tile of drops is repeated by an SVG `<pattern>` and the whole layer
 * slides down by exactly one tile height per loop, so the loop is seamless and
 * the layer is rasterised once and only moved by the compositor. Every drop sits
 * wholly inside its own cell of the tile, so none is cut by a tile edge (a cut
 * drop would show a seam on every loop) and none touches another.
 *
 * Pure and deterministic: the same drops on the server and the client, and in
 * the tests.
 */

/** The tile, in CSS pixels. `--rain-tile` in globals.css must equal the height. */
export const RAIN_TILE_W = 200;
export const RAIN_TILE_H = 320;

const COLUMNS = 6;
const ROWS = 6;
/** Drops lean this much sideways per pixel of fall (the 3D rain's slant). */
const SLANT = 0.12;
const MIN_LENGTH = 16;
const MAX_LENGTH = 34;
const MARGIN = 2;

export interface RainDrop {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 0..1, the stroke opacity: far drops are fainter and shorter. */
  opacity: number;
}

/** A small seeded generator (mulberry32): same numbers everywhere. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

let cached: readonly RainDrop[] | null = null;

/** The tile's drops, one per cell of a 6 x 6 grid. */
export function rainDrops(): readonly RainDrop[] {
  if (cached) return cached;
  const next = prng(0x5eed);
  const cellW = RAIN_TILE_W / COLUMNS;
  const cellH = RAIN_TILE_H / ROWS;
  const drops: RainDrop[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLUMNS; col++) {
      const length = MIN_LENGTH + next() * (MAX_LENGTH - MIN_LENGTH);
      const lean = length * SLANT;
      // The drop runs from (x1, y1) down and to the left by `lean`.
      const x1 =
        col * cellW + MARGIN + lean + next() * (cellW - 2 * MARGIN - lean);
      const y1 = row * cellH + MARGIN + next() * (cellH - 2 * MARGIN - length);
      const far = (length - MIN_LENGTH) / (MAX_LENGTH - MIN_LENGTH);
      drops.push({
        x1: round1(x1),
        y1: round1(y1),
        x2: round1(x1 - lean),
        y2: round1(y1 + length),
        opacity: round1(0.45 + far * 0.55),
      });
    }
  }
  cached = drops;
  return drops;
}
