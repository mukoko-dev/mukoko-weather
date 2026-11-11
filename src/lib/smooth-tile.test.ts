import { describe, expect, it } from "vitest";
import {
  MIN_SIGMA_PX,
  SMOOTH_ALPHA_GAIN,
  SMOOTH_PROTOCOL,
  SMOOTH_SIGMA_PER_CELL,
  SMOOTH_UPSCALE,
  blurMargin,
  blurRgba,
  cellPixels,
  gaussianKernel,
  neighbourTileUrls,
  parseSmoothTileUrl,
  parseWmtsTile,
  sampleTileEdgeToEdge,
  smoothSigma,
  smoothTile,
  smoothTileUrl,
} from "./smooth-tile";

const GIBS =
  "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/IMERG_Precipitation_Rate_30min/default/2026-11-10T14%3A00%3A00Z/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png";

/** A size x size tile of one colour, or clear when `rgba` is null. */
function flat(size: number, rgba: [number, number, number, number]) {
  const t = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) t.set(rgba, i * 4);
  return t;
}

/** Paints a square of one colour into a tile. */
function paint(
  tile: Uint8ClampedArray,
  size: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rgba: [number, number, number, number],
) {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) tile.set(rgba, (y * size + x) * 4);
}

const px = (t: Uint8ClampedArray, size: number, x: number, y: number) =>
  Array.from(t.subarray((y * size + x) * 4, (y * size + x) * 4 + 4));

describe("smoothed tile URLs", () => {
  it("wraps a real https tile URL and gives it back", () => {
    const wrapped = smoothTileUrl(GIBS, 0.1);
    expect(wrapped.startsWith(`${SMOOTH_PROTOCOL}://0.1/https://`)).toBe(true);
    expect(parseSmoothTileUrl(wrapped)).toEqual({
      url: GIBS,
      cellDegrees: 0.1,
    });
  });

  it("keeps MapLibre's {z}/{y}/{x} placeholders intact", () => {
    const wrapped = smoothTileUrl(GIBS, 0.1);
    expect(wrapped).toContain("{z}/{y}/{x}");
  });

  it("refuses anything that is not one of ours, or not https", () => {
    expect(parseSmoothTileUrl(GIBS)).toBeNull();
    expect(
      parseSmoothTileUrl(`${SMOOTH_PROTOCOL}://0.1/http://x.test/1/2/3.png`),
    ).toBeNull();
    expect(
      parseSmoothTileUrl(`${SMOOTH_PROTOCOL}://nope/https://x.test/1/2/3.png`),
    ).toBeNull();
    expect(
      parseSmoothTileUrl(`${SMOOTH_PROTOCOL}://0/https://x.test/1/2/3.png`),
    ).toBeNull();
    expect(parseSmoothTileUrl(`${SMOOTH_PROTOCOL}://0.1`)).toBeNull();
  });
});

describe("WMTS tile addresses", () => {
  const url = (z: number, y: number, x: number) =>
    `https://gibs.example/wmts/L/default/T/M/${z}/${y}/${x}.png`;

  it("reads z/y/x and keeps the rest of the URL", () => {
    expect(parseWmtsTile(url(6, 35, 38))).toEqual({
      prefix: "https://gibs.example/wmts/L/default/T/M/",
      z: 6,
      y: 35,
      x: 38,
      suffix: ".png",
    });
  });

  it("rejects an address outside its zoom's grid, and non-tiles", () => {
    expect(parseWmtsTile(url(2, 4, 0))).toBeNull();
    expect(parseWmtsTile(url(2, 0, 4))).toBeNull();
    expect(parseWmtsTile("https://x.test/not-a-tile")).toBeNull();
  });

  it("lists the nine tiles around one, row by row, the tile itself in the middle", () => {
    const n = neighbourTileUrls(url(6, 35, 38))!;
    expect(n).toHaveLength(9);
    expect(n[4]).toBe(url(6, 35, 38));
    expect(n[0]).toBe(url(6, 34, 37));
    expect(n[2]).toBe(url(6, 34, 39));
    expect(n[6]).toBe(url(6, 36, 37));
    expect(n[8]).toBe(url(6, 36, 39));
  });

  it("has no tile past the poles and wraps across the date line", () => {
    const top = neighbourTileUrls(url(3, 0, 0))!;
    expect(top.slice(0, 3)).toEqual([null, null, null]);
    expect(top[3]).toBe(url(3, 0, 7)); // west of x=0 is x=7
    const bottom = neighbourTileUrls(url(3, 7, 7))!;
    expect(bottom.slice(6)).toEqual([null, null, null]);
    expect(bottom[5]).toBe(url(3, 7, 0)); // east of x=7 is x=0
  });

  it("keeps a query string after the extension", () => {
    const n = neighbourTileUrls("https://x.test/a/5/10/12.png?v=1")!;
    expect(n[4]).toBe("https://x.test/a/5/10/12.png?v=1");
    expect(n[0]).toBe("https://x.test/a/5/9/11.png?v=1");
  });
});

describe("how much to blur", () => {
  it("measures the IMERG cell in tile pixels, the figure the layer was capped by", () => {
    // 0.1 degree at tile zoom 6: 0.1/360 * 256 * 64 = 4.55 px (map-sources.ts says 4.5).
    expect(cellPixels(0.1, 6)).toBeCloseTo(4.55, 2);
    expect(cellPixels(0.1, 7)).toBeCloseTo(9.1, 1);
  });

  it("blurs by a fixed share of one cell", () => {
    expect(smoothSigma(0.1, 6)).toBeCloseTo(SMOOTH_SIGMA_PER_CELL * 4.55, 2);
  });

  it("builds a normalised, symmetric kernel", () => {
    const k = gaussianKernel(2.7);
    const sum = Array.from(k).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
    expect(k.length).toBe(2 * blurMargin(2.7) + 1);
    const mid = (k.length - 1) / 2;
    for (let i = 0; i < mid; i++)
      expect(k[i]).toBeCloseTo(k[k.length - 1 - i], 6);
    expect(k[mid]).toBeGreaterThan(k[mid - 1]);
  });
});

describe("blurRgba (straight alpha in and out)", () => {
  it("leaves a uniform opaque area exactly as it was", () => {
    const size = 24;
    const t = flat(size, [10, 120, 200, 255]);
    const out = blurRgba(t, size, size, 2);
    // Away from the (transparent) outside the colour and alpha are untouched.
    expect(px(out, size, 12, 12)).toEqual([10, 120, 200, 255]);
  });

  it("keeps clear pixels clear", () => {
    const size = 16;
    const out = blurRgba(flat(size, [0, 0, 0, 0]), size, size, 2);
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });

  it("fades a coloured square into its clear surroundings without changing its colour", () => {
    const size = 40;
    const t = flat(size, [0, 0, 0, 0]);
    paint(t, size, 15, 15, 10, 10, [30, 160, 40, 255]);
    const out = blurRgba(t, size, size, 3);
    // Outside the square, alpha rises toward the square but the hue stays the square's:
    // premultiplied blur must not grey it (a straight blur would darken toward black).
    const edge = px(out, size, 13, 20);
    expect(edge[3]).toBeGreaterThan(0);
    expect(edge[3]).toBeLessThan(200);
    expect(edge[0]).toBeCloseTo(30, 0);
    expect(edge[1]).toBeCloseTo(160, 0);
    expect(edge[2]).toBeCloseTo(40, 0);
    // The edge is a ramp, not a step: alpha falls monotonically moving away.
    const alphas = [20, 16, 14, 12, 10, 8].map((x) => px(out, size, x, 20)[3]);
    for (let i = 1; i < alphas.length; i++)
      expect(alphas[i]).toBeLessThanOrEqual(alphas[i - 1]);
  });

  it("blends two adjacent cells of different colours into a gradient", () => {
    const size = 40;
    const t = flat(size, [0, 0, 0, 0]);
    paint(t, size, 10, 10, 10, 20, [0, 100, 0, 255]); // dark green
    paint(t, size, 20, 10, 10, 20, [200, 220, 0, 255]); // yellow-green
    const out = blurRgba(t, size, size, 3);
    const reds = [14, 17, 19, 20, 22, 25].map((x) => px(out, size, x, 20)[0]);
    // Red rises smoothly across the boundary between the two cells.
    for (let i = 1; i < reds.length; i++)
      expect(reds[i]).toBeGreaterThanOrEqual(reds[i - 1]);
    expect(reds[0]).toBeLessThan(20);
    expect(reds[5]).toBeGreaterThan(150);
    // There is no single-pixel jump of the original box edge (200 levels) left.
    const steps = reds.slice(1).map((v, i) => v - reds[i]);
    expect(Math.max(...steps)).toBeLessThan(120);
  });
});

describe("smoothTile (a tile smoothed with its neighbours' margin)", () => {
  const size = 32;
  const sigma = 2.5;
  const clear = () => flat(size, [0, 0, 0, 0]);
  const nine = (centre: Uint8ClampedArray | null) => {
    const t: (Uint8ClampedArray | null)[] = Array.from({ length: 9 }, clear);
    t[4] = centre;
    return t;
  };

  it("returns null without a middle tile and the tile itself for a negligible blur", () => {
    expect(smoothTile(nine(null), size, sigma)).toBeNull();
    const c = flat(size, [1, 2, 3, 255]);
    expect(smoothTile(nine(c), size, MIN_SIGMA_PX / 2)).toBe(c);
    expect(smoothTile(nine(c), size, NaN)).toBe(c);
  });

  it("returns a tile the same size as the input", () => {
    const out = smoothTile(nine(clear()), size, sigma, { scale: 1 })!;
    expect(out.length).toBe(size * size * 4);
  });

  it("has no seam where a cell straddles the edge between two tiles", () => {
    // A 12 px wide cell centred on the boundary between the middle tile (west) and its eastern neighbour.
    const west = clear();
    const east = clear();
    paint(west, size, size - 6, 8, 6, 16, [20, 150, 30, 255]);
    paint(east, size, 0, 8, 6, 16, [20, 150, 30, 255]);
    const t1 = nine(west);
    t1[5] = east;
    const a = smoothTile(t1, size, sigma, { alphaGain: 1, scale: 1 })!;
    // Same data seen from the eastern tile: its western neighbour is `west`.
    const t2 = nine(east);
    t2[3] = west;
    const b = smoothTile(t2, size, sigma, { alphaGain: 1, scale: 1 })!;
    // Moving across the boundary the alpha is continuous: the last column of
    // the western tile and the first of the eastern differ by about one
    // pixel's slope, not by a box edge.
    const lastA = px(a, size, size - 1, 16)[3];
    const firstB = px(b, size, 0, 16)[3];
    const beforeLastA = px(a, size, size - 2, 16)[3];
    expect(Math.abs(lastA - firstB)).toBeLessThanOrEqual(
      Math.abs(lastA - beforeLastA) + 2,
    );
    // And without the neighbour's margin the same pixel would be much weaker.
    const alone = smoothTile(nine(west), size, sigma, {
      alphaGain: 1,
      scale: 1,
    })!;
    expect(px(alone, size, size - 1, 16)[3]).toBeLessThan(lastA - 20);
  });

  it("keeps a lone rain cell visible: the gain restores the opacity the blur took", () => {
    // One IMERG-sized cell (4-5 px) in the middle of an otherwise dry tile.
    const c = clear();
    paint(c, size, 14, 14, 5, 5, [30, 160, 40, 255]);
    const plain = smoothTile(nine(c), size, smoothSigma(0.1, 6), {
      alphaGain: 1,
      scale: 1,
    })!;
    const gained = smoothTile(nine(c), size, smoothSigma(0.1, 6), {
      scale: 1,
    })!;
    const peak = (t: Uint8ClampedArray) => px(t, size, 16, 16)[3];
    expect(peak(plain)).toBeLessThan(0.75 * 255); // the blur alone washes it out
    expect(peak(gained)).toBeGreaterThan(peak(plain));
    expect(peak(gained)).toBeGreaterThanOrEqual(0.7 * 255);
    expect(SMOOTH_ALPHA_GAIN).toBeGreaterThan(1);
    // It is still soft: the tile's far corner is clear and the edge ramps.
    expect(px(gained, size, 0, 0)[3]).toBe(0);
    const ramp = [16, 19, 22, 25].map((x) => px(gained, size, x, 16)[3]);
    for (let i = 1; i < ramp.length; i++)
      expect(ramp[i]).toBeLessThanOrEqual(ramp[i - 1]);
    expect(ramp[0]).toBeGreaterThan(ramp[3]);
  });

  it("never lets the gain push alpha past opaque", () => {
    const c = flat(size, [10, 20, 30, 255]);
    const out = smoothTile(nine(c), size, sigma, { alphaGain: 3, scale: 1 })!;
    expect(px(out, size, size / 2, size / 2)[3]).toBe(255);
  });

  it("treats a missing neighbour as clear rather than failing", () => {
    const c = flat(size, [0, 0, 0, 0]);
    paint(c, size, 0, 0, size, size, [50, 60, 70, 255]);
    const t = nine(c);
    t[0] = null;
    t[8] = null;
    const out = smoothTile(t, size, sigma, { scale: 1 })!;
    expect(px(out, size, size / 2, size / 2)).toEqual([50, 60, 70, 255]);
    // The tile's edge fades toward the clear (absent) neighbour, never errors.
    expect(px(out, size, 0, size / 2)[3]).toBeLessThan(255);
  });

  it("returns the tile scale times finer by default, the same field sampled more often", () => {
    expect(SMOOTH_UPSCALE).toBe(2);
    const c = clear();
    paint(c, size, 10, 10, 8, 8, [30, 160, 40, 255]);
    const fine = smoothTile(nine(c), size, sigma)!;
    expect(fine.length).toBe(size * 2 * size * 2 * 4);
    const native = smoothTile(nine(c), size, sigma, { scale: 1 })!;
    // The middle of the cell is the same colour at either size.
    expect(px(fine, size * 2, 28, 28).slice(0, 3)).toEqual(
      px(native, size, 14, 14).slice(0, 3),
    );
    expect(px(fine, size * 2, 28, 28)[3]).toBe(px(native, size, 14, 14)[3]);
  });

  it("makes neighbouring tiles agree exactly on their shared border (no seam)", () => {
    // A cell straddling the border between the middle tile and the one south of
    // it, and another straddling the one to its east. Each tile is smoothed on
    // its own, with the other as its neighbour.
    const centre = clear();
    const south = clear();
    const east = clear();
    paint(centre, size, 6, size - 6, 10, 6, [20, 150, 30, 255]);
    paint(south, size, 6, 0, 10, 6, [20, 150, 30, 255]);
    paint(centre, size, size - 6, 4, 6, 12, [200, 210, 20, 255]);
    paint(east, size, 0, 4, 6, 12, [200, 210, 20, 255]);
    const side = size * SMOOTH_UPSCALE;
    const m = nine(centre);
    m[7] = south;
    m[5] = east;
    const a = smoothTile(m, size, sigma)!;
    const ms = nine(south);
    ms[1] = centre;
    const b = smoothTile(ms, size, sigma)!;
    const me = nine(east);
    me[3] = centre;
    const c = smoothTile(me, size, sigma)!;
    for (let x = 0; x < side; x++) {
      // Last row of the middle tile = first row of the one south of it.
      expect(px(a, side, x, side - 1)).toEqual(px(b, side, x, 0));
    }
    for (let y = 0; y < side; y++) {
      // Last column of the middle tile = first column of the one east of it.
      expect(px(a, side, side - 1, y)).toEqual(px(c, side, 0, y));
    }
    // And the shared border is not empty: there is rain to disagree about.
    expect(px(a, side, 2 * 8 + 4, side - 1)[3]).toBeGreaterThan(40);
  });

  it("samples edge to edge, the colour weighted by alpha", () => {
    // 4 x 4, no margin: the top two rows opaque green, the bottom two clear.
    const src = new Uint8ClampedArray(4 * 4 * 4);
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 4; x++) src.set([0, 200, 0, 255], (y * 4 + x) * 4);
    const out = sampleTileEdgeToEdge(src, 4, 0, 4, 5); // texels at y = 0..4
    const col = (y: number) => px(out, 5, 2, y);
    // The first texel is the field at the border: still full green.
    expect(col(0)).toEqual([0, 200, 0, 255]);
    // Between rows 1 (opaque) and 2 (clear): half opacity, the colour NOT greyed.
    expect(col(2)[3]).toBe(128);
    expect(col(2).slice(0, 3)).toEqual([0, 200, 0]);
    // Past the last opaque row the field is clear.
    expect(col(4)[3]).toBe(0);
    const alphas = [0, 1, 2, 3, 4].map((y) => col(y)[3]);
    for (let i = 1; i < alphas.length; i++)
      expect(alphas[i]).toBeLessThanOrEqual(alphas[i - 1]);
  });

  it("returns a clear tile without blurring when the whole block is dry", () => {
    const out = smoothTile(nine(clear()), size, sigma)!;
    expect(out.length).toBe(size * 2 * size * 2 * 4);
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });

  it("ignores a neighbour of the wrong size", () => {
    const c = flat(size, [0, 0, 0, 0]);
    const t = nine(c);
    t[1] = new Uint8ClampedArray(7);
    expect(() => smoothTile(t, size, sigma)).not.toThrow();
  });
});
