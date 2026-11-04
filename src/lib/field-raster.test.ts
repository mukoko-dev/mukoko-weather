import { describe, it, expect } from "vitest";
import {
  CONTOUR_MIN_ALPHA,
  FEATHER_CELLS,
  MAX_RASTER_SIDE,
  NO_BAND,
  RASTER_SIDE,
  RASTER_SIDE_CONSTRAINED,
  buildFieldRaster,
  contourLines,
  featherAlpha,
  interpolateAt,
  latFromMercatorY,
  mercatorY,
  paintRaster,
  parseCssColor,
  sampleGridFrom,
  type FieldRaster,
  type FieldSample,
  type SampleGrid,
} from "./field-raster";

const KM_PER_DEG = 111.195;

/** The Workers' build_grid (row-major north-west to south-east), with values from `f`. */
function workerGrid(
  lat: number,
  lon: number,
  radiusKm: number,
  n: number,
  f: (row: number, col: number) => number | null,
): FieldSample[] {
  const half = (n - 1) / 2;
  const step = radiusKm / half;
  const kmPerDegLon = KM_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const out: FieldSample[] = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      out.push({
        lat: +(lat + ((half - row) * step) / KM_PER_DEG).toFixed(6),
        lon: +(lon + ((col - half) * step) / kmPerDegLon).toFixed(6),
        value: f(row, col),
      });
    }
  }
  return out;
}

/** A tiny deterministic PRNG so the property tests are repeatable. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function gridOf(samples: FieldSample[]): SampleGrid {
  const g = sampleGridFrom(samples);
  if (!g) throw new Error("expected a grid");
  return g;
}

describe("sampleGridFrom", () => {
  it("structures a Worker grid: ascending latitudes, ascending longitudes, values in place", () => {
    // Row 0 is the NORTH row in the Worker's output; the grid runs south to north.
    const g = gridOf(workerGrid(-17.83, 31.05, 40, 7, (r, c) => r * 10 + c));
    expect(g.lats).toHaveLength(7);
    expect(g.lons).toHaveLength(7);
    expect([...g.lats].sort((a, b) => a - b)).toEqual(g.lats);
    expect([...g.lons].sort((a, b) => a - b)).toEqual(g.lons);
    // grid row 0 is the southernmost = Worker row 6; column 0 is the westernmost.
    expect(g.values[0]).toBe(60);
    expect(g.values[6]).toBe(66);
    expect(g.values[6 * 7]).toBe(0);
    expect(g.values[6 * 7 + 6]).toBe(6);
  });

  it("merges coordinates that differ only by rounding into one grid line", () => {
    const samples = workerGrid(0, 0, 40, 5, () => 1).map((s, i) => ({
      ...s,
      lon: s.lon + (i % 2) * 2e-6,
    }));
    const g = gridOf(samples);
    expect(g.lons).toHaveLength(5);
    expect(g.lats).toHaveLength(5);
  });

  it("keeps a missing or non-finite reading as null, never as a number", () => {
    const g = gridOf(
      workerGrid(10, 20, 40, 5, (r, c) =>
        r === 2 && c === 2 ? null : r === 0 && c === 0 ? Number.NaN : 5,
      ),
    );
    expect(g.values.filter((v) => v === null)).toHaveLength(2);
    expect(g.values.every((v) => v === null || v === 5)).toBe(true);
  });

  it("returns null when there is no grid to speak of", () => {
    expect(sampleGridFrom([])).toBeNull();
    expect(
      sampleGridFrom([
        { lat: 0, lon: 0, value: 1 },
        { lat: 0, lon: 1, value: 1 },
        { lat: 0, lon: 2, value: 1 },
        { lat: 0, lon: 3, value: 1 },
      ]),
    ).toBeNull(); // one row only
    expect(
      sampleGridFrom([
        { lat: Number.NaN, lon: 0, value: 1 },
        { lat: 0, lon: Number.NaN, value: 1 },
        { lat: 0, lon: 1, value: 1 },
      ]),
    ).toBeNull();
  });

  it("refuses a grid larger than the app ever asks for", () => {
    const big: FieldSample[] = [];
    for (let r = 0; r < 40; r++)
      for (let c = 0; c < 40; c++) big.push({ lat: r, lon: c, value: 1 });
    expect(sampleGridFrom(big)).toBeNull();
  });

  it("unwraps a grid that crosses the antimeridian so its columns stay in order", () => {
    // /v1/model-grid wraps longitudes into [-180, 180): 179.8, 179.9, -180, -179.9 ...
    const lons = [179.7, 179.9, -179.9, -179.7];
    const samples: FieldSample[] = [];
    for (const lat of [0, 0.2]) {
      lons.forEach((lon, c) => samples.push({ lat, lon, value: c }));
    }
    const g = gridOf(samples);
    expect(g.lons.map((l) => +l.toFixed(3))).toEqual([
      179.7, 179.9, 180.1, 180.3,
    ]);
    expect(g.values.slice(0, 4)).toEqual([0, 1, 2, 3]);
  });
});

describe("interpolateAt", () => {
  const field = (row: number, col: number) =>
    20 + 7 * Math.sin(row * 1.3) * Math.cos(col * 0.9) + 3 * row - 2 * col;
  const grid = gridOf(workerGrid(-17.83, 31.05, 40, 7, field));

  it("returns the reading itself at every sample point", () => {
    grid.lats.forEach((lat, j) => {
      grid.lons.forEach((lon, i) => {
        expect(interpolateAt(grid, lat, lon)).toBeCloseTo(
          grid.values[j * grid.lons.length + i] as number,
          9,
        );
      });
    });
  });

  it("never leaves the range of the four surrounding readings (no overshoot)", () => {
    const rand = prng(7);
    // Spiky data is where a plain cubic overshoots: one hot cell in cool air.
    const spiky = gridOf(
      workerGrid(0, 0, 40, 7, (r, c) => (r === 3 && c === 3 ? 400 : 20)),
    );
    for (const g of [grid, spiky]) {
      const cols = g.lons.length;
      for (let k = 0; k < 4000; k++) {
        const j = Math.floor(rand() * (g.lats.length - 1));
        const i = Math.floor(rand() * (cols - 1));
        const lat = g.lats[j] + rand() * (g.lats[j + 1] - g.lats[j]);
        const lon = g.lons[i] + rand() * (g.lons[i + 1] - g.lons[i]);
        const corners = [
          g.values[j * cols + i],
          g.values[j * cols + i + 1],
          g.values[(j + 1) * cols + i],
          g.values[(j + 1) * cols + i + 1],
        ] as number[];
        const v = interpolateAt(g, lat, lon);
        expect(v).toBeGreaterThanOrEqual(Math.min(...corners) - 1e-9);
        expect(v).toBeLessThanOrEqual(Math.max(...corners) + 1e-9);
      }
    }
  });

  it("a missing reading that carries no weight here never turns the point into a hole", () => {
    // On a grid line, or in the half-cell margin, one pair of corners weighs
    // nothing. If that reading is null the point must still take the value of
    // the readings that do count, not NaN (the cubic needs all four corners).
    // A point exactly on a sample falls at the far end (t = 1) of the cell
    // before it, so the readings WEST and SOUTH of it are the cell's other
    // corners, with no weight at all.
    const cols = grid.lons.length;
    for (const [row, col] of [
      [3, 2],
      [2, 3],
      [2, 2],
    ]) {
      const values = [...grid.values];
      values[row * cols + col] = null;
      const gapped = { ...grid, values };
      const at = interpolateAt(gapped, grid.lats[3], grid.lons[3]);
      expect(Number.isFinite(at), `${row},${col}`).toBe(true);
      expect(at).toBeCloseTo(grid.values[3 * cols + 3] as number, 9);
    }
    // And in the half-cell margin outside the grid it is the nearest edge value.
    const margin = interpolateAt(
      grid,
      grid.lats[grid.lats.length - 1] + 0.01,
      grid.lons[0] - 0.01,
    );
    expect(Number.isFinite(margin)).toBe(true);
  });

  it("reproduces a plane exactly, and is monotone along a ramp", () => {
    const plane = gridOf(workerGrid(5, 5, 40, 7, (r, c) => 10 + 4 * c + 2 * r));
    const mid = interpolateAt(
      plane,
      (plane.lats[2] + plane.lats[3]) / 2,
      (plane.lons[3] + plane.lons[4]) / 2,
    );
    // Row 2 and 3 from the SOUTH are Worker rows 4 and 3: r = 6 - j.
    const expected =
      (10 +
        4 * 3 +
        2 * 4 +
        (10 + 4 * 4 + 2 * 4) +
        (10 + 4 * 3 + 2 * 3) +
        (10 + 4 * 4 + 2 * 3)) /
      4;
    expect(mid).toBeCloseTo(expected, 9);

    const lat = plane.lats[3];
    let last = -Infinity;
    for (let k = 0; k <= 60; k++) {
      const lon = plane.lons[0] + (k / 60) * (plane.lons[6] - plane.lons[0]);
      const v = interpolateAt(plane, lat, lon);
      expect(v).toBeGreaterThanOrEqual(last - 1e-9);
      last = v;
    }
  });

  it("holds the edge value in the margin outside the grid", () => {
    const west = interpolateAt(grid, grid.lats[3], grid.lons[0] - 5);
    expect(west).toBeCloseTo(
      interpolateAt(grid, grid.lats[3], grid.lons[0]),
      9,
    );
    const corner = interpolateAt(grid, grid.lats[0] - 5, grid.lons[6] + 5);
    expect(corner).toBeCloseTo(grid.values[6] as number, 9);
  });

  it("leaves a hole (NaN) at a missing reading, not a zero", () => {
    const holed = gridOf(
      workerGrid(0, 0, 40, 7, (r, c) => (r === 3 && c === 3 ? null : 50)),
    );
    expect(
      Number.isNaN(interpolateAt(holed, holed.lats[3], holed.lons[3])),
    ).toBe(true);
  });

  it("never pulls a value toward zero near a hole: every other point stays 50", () => {
    const holed = gridOf(
      workerGrid(0, 0, 40, 7, (r, c) => (r === 3 && c === 3 ? null : 50)),
    );
    let holes = 0;
    for (let k = 0; k < 40; k++) {
      for (let m = 0; m < 40; m++) {
        const lat = holed.lats[0] + (k / 39) * (holed.lats[6] - holed.lats[0]);
        const lon = holed.lons[0] + (m / 39) * (holed.lons[6] - holed.lons[0]);
        const v = interpolateAt(holed, lat, lon);
        if (Number.isNaN(v)) holes++;
        else expect(v).toBeCloseTo(50, 9);
      }
    }
    expect(holes).toBeGreaterThan(0);
    // The hole is local: far from the missing reading everything is still filled.
    expect(interpolateAt(holed, holed.lats[0], holed.lons[0])).toBeCloseTo(
      50,
      9,
    );
    expect(interpolateAt(holed, holed.lats[6], holed.lons[5])).toBeCloseTo(
      50,
      9,
    );
  });

  it("blanks only about the missing reading's own neighbourhood", () => {
    const holed = gridOf(
      workerGrid(0, 0, 40, 7, (r, c) => (r === 3 && c === 3 ? null : 10)),
    );
    // A point most of the way to a neighbour is filled; the sample itself is not.
    const toward = interpolateAt(
      holed,
      holed.lats[3],
      holed.lons[3] + 0.8 * (holed.lons[4] - holed.lons[3]),
    );
    expect(toward).toBeCloseTo(10, 9);
  });
});

describe("web mercator rows", () => {
  it("round-trips latitudes and is zero at the equator", () => {
    expect(mercatorY(0)).toBeCloseTo(0, 12);
    for (const lat of [-60, -17.83, 1.35, 33, 70]) {
      expect(latFromMercatorY(mercatorY(lat))).toBeCloseTo(lat, 9);
    }
  });

  it("clamps latitudes beyond the map's own limit", () => {
    expect(mercatorY(89.9)).toBeCloseTo(mercatorY(85.0511287798), 9);
    expect(Number.isFinite(mercatorY(-90))).toBe(true);
  });
});

describe("buildFieldRaster", () => {
  /** Two bands split at 50.5, like the AQI scale's good/moderate edge. */
  const spec = {
    classify: (v: number) => (v >= 50.5 ? 1 : 0),
    tokens: ["--a", "--b"],
    levels: [50.5],
  };

  it("never exceeds the size cap, whatever side is asked for", () => {
    const g = gridOf(workerGrid(0, 0, 40, 7, () => 10));
    for (const side of [4, 96, 500, 5000]) {
      const r = buildFieldRaster(g, { ...spec, side });
      expect(r.width).toBeLessThanOrEqual(MAX_RASTER_SIDE);
      expect(r.height).toBeLessThanOrEqual(MAX_RASTER_SIDE);
      expect(r.bands).toHaveLength(r.width * r.height);
      expect(r.alpha).toHaveLength(r.width * r.height);
      expect(r.values).toHaveLength(r.width * r.height);
    }
    expect(RASTER_SIDE).toBeLessThanOrEqual(MAX_RASTER_SIDE);
    expect(RASTER_SIDE_CONSTRAINED).toBeLessThan(RASTER_SIDE);
    expect(RASTER_SIDE_CONSTRAINED).toBeGreaterThanOrEqual(64);
    const r = buildFieldRaster(g, { ...spec, side: RASTER_SIDE });
    expect(Math.max(r.width, r.height)).toBe(RASTER_SIDE);
  });

  it("keeps pixels square on the ground at any latitude (the image is Web Mercator)", () => {
    for (const lat of [0, -17.8, 45, 60, 75]) {
      const g = gridOf(workerGrid(lat, 10, 40, 7, () => 10));
      const r = buildFieldRaster(g, { ...spec, side: 96 });
      // A grid that is square in km is square in Web Mercator too.
      expect(Math.abs(r.width - r.height)).toBeLessThanOrEqual(1);
    }
    // A wider-than-tall grid gets a wider-than-tall image.
    const wide = gridOf(
      [0, 1, 2].flatMap((row) =>
        [0, 1, 2, 3, 4, 5].map((col) => ({
          lat: row * 0.1,
          lon: col * 0.1,
          value: 1,
        })),
      ),
    );
    const r = buildFieldRaster(wide, { ...spec, side: 96 });
    expect(r.width).toBeGreaterThan(r.height);
  });

  it("covers the samples plus half a cell, as the square cells did", () => {
    const g = gridOf(workerGrid(0, 0, 40, 7, () => 10));
    const r = buildFieldRaster(g, { ...spec, side: 96 });
    // Half the gap beside each outer sample (the Worker rounds to 6 decimals,
    // so the first and last gaps differ from the mean by a hair).
    expect(r.extent.west).toBeCloseTo(
      g.lons[0] - (g.lons[1] - g.lons[0]) / 2,
      9,
    );
    expect(r.extent.east).toBeCloseTo(
      g.lons[6] + (g.lons[6] - g.lons[5]) / 2,
      9,
    );
    expect(r.corners[0]).toEqual([r.extent.west, r.extent.north]);
    expect(r.corners[1]).toEqual([r.extent.east, r.extent.north]);
    expect(r.corners[2]).toEqual([r.extent.east, r.extent.south]);
    expect(r.corners[3]).toEqual([r.extent.west, r.extent.south]);
  });

  it("puts each band boundary on the legend's breakpoint", () => {
    // A west-to-east ramp 0..100 across 7 columns: the 50.5 edge is at 50.5%.
    const g = gridOf(workerGrid(0, 0, 40, 7, (_, c) => (c * 100) / 6));
    const r = buildFieldRaster(g, { ...spec, side: 96 });
    const row = Math.floor(r.height / 2);
    let firstHigh = -1;
    for (let x = 0; x < r.width; x++) {
      if (r.bands[row * r.width + x] === 1) {
        firstHigh = x;
        break;
      }
    }
    expect(firstHigh).toBeGreaterThan(0);
    // Every pixel left of the boundary is below the level, every one right of it above.
    for (let x = 0; x < r.width; x++) {
      const v = r.values[row * r.width + x];
      const band = r.bands[row * r.width + x];
      expect(band).toBe(v >= 50.5 ? 1 : 0);
    }
    // And the boundary sits where the ramp reaches 50.5 (within a pixel).
    const lonAt = (x: number) =>
      r.extent.west + ((x + 0.5) / r.width) * (r.extent.east - r.extent.west);
    const lonOf505 = g.lons[0] + (50.5 / 100) * (g.lons[6] - g.lons[0]);
    const pxWidthDeg = (r.extent.east - r.extent.west) / r.width;
    expect(Math.abs(lonAt(firstHigh) - lonOf505)).toBeLessThanOrEqual(
      pxWidthDeg,
    );
  });

  it("classifies with the caller's rule, including NO_BAND for 'below the first band'", () => {
    const g = gridOf(workerGrid(0, 0, 40, 5, (_, c) => c * 0.05));
    const r = buildFieldRaster(g, {
      classify: (v) => (v < 0.1 ? NO_BAND : 0),
      tokens: ["--rain"],
      side: 40,
    });
    expect(r.bands.some((b) => b === NO_BAND)).toBe(true);
    expect(r.bands.some((b) => b === 0)).toBe(true);
    // Below-band pixels are NOT holes: they keep their value (for the contour).
    const i = r.bands.indexOf(NO_BAND);
    expect(Number.isNaN(r.values[i])).toBe(false);
    expect(r.values[i]).toBeLessThan(0.1);
  });

  it("leaves a transparent hole where a sample is missing and nowhere else", () => {
    const g = gridOf(
      workerGrid(0, 0, 40, 7, (r, c) => (r === 3 && c === 3 ? null : 80)),
    );
    const r = buildFieldRaster(g, { ...spec, side: 96 });
    const holes = [...r.bands].filter((b) => b === NO_BAND).length;
    const nanCount = [...r.values].filter(Number.isNaN).length;
    expect(holes).toBeGreaterThan(0);
    expect(nanCount).toBe(holes);
    // The hole is around the middle of the image, not at its corners.
    const centre = Math.floor(r.height / 2) * r.width + Math.floor(r.width / 2);
    expect(r.bands[centre]).toBe(NO_BAND);
    expect(r.bands[0]).not.toBe(NO_BAND);
    expect(r.bands[r.bands.length - 1]).not.toBe(NO_BAND);
    // A hole is small: under a tenth of the image for one missing sample of 49.
    expect(holes).toBeLessThan((r.width * r.height) / 10);
    // The painted pixels are transparent there.
    const rgba = paintRaster(r, [
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(rgba[centre * 4 + 3]).toBe(0);
  });

  it("holds the sample's own value at the pixel that sits on it", () => {
    // 5 x 5 samples near the equator, 7 pixels per cell: odd, so a pixel centre
    // lands exactly on each sample column.
    const g = gridOf(
      workerGrid(0, 0, 4, 5, (r, c) => 10 + 6 * c + 3 * r + (r + c) ** 2 / 4),
    );
    const r = buildFieldRaster(g, { ...spec, side: 35 });
    expect(r.width).toBe(35);
    expect(r.height).toBe(35);
    for (let j = 0; j < 5; j++) {
      for (let i = 0; i < 5; i++) {
        const sample = g.values[j * 5 + i] as number;
        // Row j counts from the south; image row 0 is the north.
        const py = (4 - j) * 7 + 3;
        const px = i * 7 + 3;
        expect(r.values[py * r.width + px]).toBeCloseTo(sample, 1);
      }
    }
  });

  it("fades the alpha from nothing at the edge to full inside, over one source cell", () => {
    const g = gridOf(workerGrid(0, 0, 40, 7, () => 10));
    const r = buildFieldRaster(g, { ...spec, side: 96 });
    const cellPx = r.width / 7;
    const mid = Math.floor(r.height / 2);
    const row = (x: number) => r.alpha[mid * r.width + x];
    // 0 at the very edge (the first pixel centre is a fraction of a pixel in) ...
    expect(row(0)).toBeLessThanOrEqual(2);
    // ... non-decreasing up to one cell in ...
    for (let x = 1; x < Math.ceil(cellPx * FEATHER_CELLS); x++) {
      expect(row(x)).toBeGreaterThanOrEqual(row(x - 1));
    }
    // ... and full from one source cell in to one cell from the other edge.
    for (
      let x = Math.ceil(cellPx * FEATHER_CELLS) + 1;
      x < r.width - cellPx - 1;
      x++
    ) {
      expect(row(x)).toBe(255);
    }
    // The same on every side: top, bottom and right.
    const midX = Math.floor(r.width / 2);
    expect(r.alpha[midX]).toBeLessThanOrEqual(2);
    expect(r.alpha[(r.height - 1) * r.width + midX]).toBeLessThanOrEqual(2);
    expect(r.alpha[mid * r.width + r.width - 1]).toBeLessThanOrEqual(2);
    // The corner is the faintest point; no pixel is fainter than the corner.
    expect(r.alpha[0]).toBeLessThanOrEqual(r.alpha[mid * r.width]);
  });

  it("takes the legend's tokens and levels along for painting and outlines", () => {
    const g = gridOf(workerGrid(0, 0, 40, 5, () => 10));
    const r = buildFieldRaster(g, { ...spec, side: 32 });
    expect(r.tokens).toEqual(["--a", "--b"]);
    expect(r.levels).toEqual([50.5]);
    expect(
      buildFieldRaster(g, { classify: () => 0, tokens: [] }).levels,
    ).toEqual([]);
  });
});

describe("block-constant data (a coarse model sampled finer than its own cells)", () => {
  // CAMS air quality is about 44 km per cell and the grid samples it every
  // 13 km, so the Worker returns the SAME number in blocks of 3 or 4 columns
  // (85, 85, 85, 62, 62, 62, 62). The smoothing must not pretend otherwise.
  const levelSpec = {
    classify: (v: number) => (v >= 50.5 ? 1 : 0),
    tokens: ["--a", "--b"],
    levels: [50.5],
    side: 96,
  };
  const lonOf = (r: FieldRaster, x: number) =>
    r.extent.west + ((x + 0.5) / r.width) * (r.extent.east - r.extent.west);

  it("keeps every block's own value flat and ramps only across ONE sample cell", () => {
    const g = gridOf(workerGrid(0, 0, 40, 7, (_, c) => (c < 3 ? 45 : 62)));
    const r = buildFieldRaster(g, levelSpec);
    const row = Math.floor(r.height / 2);
    const cellPx = r.width / 7;
    let ramp = 0;
    let last = -Infinity;
    for (let x = 0; x < r.width; x++) {
      const v = r.values[row * r.width + x];
      const lon = lonOf(r, x);
      if (lon <= g.lons[2] + 1e-9) expect(v).toBeCloseTo(45, 4);
      else if (lon >= g.lons[3] - 1e-9) expect(v).toBeCloseTo(62, 4);
      else ramp++;
      expect(v).toBeGreaterThanOrEqual(last - 1e-4); // monotone
      expect(v).toBeGreaterThanOrEqual(45 - 1e-4); // no overshoot
      expect(v).toBeLessThanOrEqual(62 + 1e-4);
      last = v;
    }
    // The ramp is the one gap between the last sample of one block and the
    // first of the next, not a smear across the blocks.
    expect(ramp).toBeGreaterThan(0);
    expect(ramp).toBeLessThanOrEqual(Math.ceil(cellPx) + 1);
  });

  it("puts the band edge inside that ramp, as a single vertical line", () => {
    const g = gridOf(workerGrid(0, 0, 40, 7, (_, c) => (c < 3 ? 45 : 62)));
    const r = buildFieldRaster(g, levelSpec);
    const fc = contourLines(r);
    expect(fc.features).toHaveLength(1);
    const pixel = (r.extent.east - r.extent.west) / r.width;
    for (const line of fc.features[0].geometry.coordinates) {
      for (const [lon] of line) {
        expect(lon).toBeGreaterThanOrEqual(g.lons[2] - pixel);
        expect(lon).toBeLessThanOrEqual(g.lons[3] + pixel);
      }
    }
  });

  it("invents nothing at the corner where four blocks meet", () => {
    // The two-by-two blocks of a real response: 85 | 62 over 76 | 63.
    const g = gridOf(
      workerGrid(0, 0, 40, 7, (row, col) =>
        row < 3 ? (col < 3 ? 85 : 62) : col < 3 ? 76 : 63,
      ),
    );
    const r = buildFieldRaster(g, { ...levelSpec, side: 96 });
    const blockValues = [85, 62, 76, 63];
    let flat = 0;
    for (const v of r.values) {
      expect(v).toBeGreaterThanOrEqual(62 - 1e-4);
      expect(v).toBeLessThanOrEqual(85 + 1e-4);
      if (blockValues.some((b) => Math.abs(v - b) < 1e-3)) flat++;
    }
    // Most of the picture IS the blocks' own values: the smoothing softens the
    // seams, it does not turn the data into a different field.
    expect(flat / r.values.length).toBeGreaterThan(0.6);
  });
});

describe("featherAlpha", () => {
  it("is 0 at the edge, 255 from FEATHER_CELLS in, and non-decreasing between", () => {
    expect(featherAlpha(0)).toBe(0);
    expect(featherAlpha(-3)).toBe(0);
    expect(featherAlpha(FEATHER_CELLS)).toBe(255);
    expect(featherAlpha(FEATHER_CELLS * 4)).toBe(255);
    let last = -1;
    for (let k = 0; k <= 20; k++) {
      const a = featherAlpha((k / 20) * FEATHER_CELLS);
      expect(a).toBeGreaterThanOrEqual(last);
      last = a;
    }
  });
});

describe("parseCssColor", () => {
  it.each([
    ["#00e400", [0, 228, 0]],
    ["#0E4", [0, 238, 68]],
    ["#7E0023", [126, 0, 35]],
    ["#7e002380", [126, 0, 35]],
    ["rgb(143, 63, 151)", [143, 63, 151]],
    ["rgba(255, 126, 0, 0.5)", [255, 126, 0]],
    ["rgb(255 0 0 / 50%)", [255, 0, 0]],
    ["  #ffff00 ", [255, 255, 0]],
  ])("reads %s", (css, rgb) => {
    expect(parseCssColor(css)).toEqual(rgb);
  });

  it("returns null for anything it cannot read, so the caller can ask the browser", () => {
    for (const bad of ["", "var(--x)", "oklch(0.7 0.1 150)", "banana", "#12"]) {
      expect(parseCssColor(bad)).toBeNull();
    }
  });
});

describe("paintRaster", () => {
  const r: FieldRaster = {
    width: 3,
    height: 1,
    bands: Int8Array.from([0, 1, NO_BAND]),
    alpha: Uint8ClampedArray.from([255, 128, 255]),
    values: Float32Array.from([1, 2, Number.NaN]),
    tokens: ["--a", "--b"],
    levels: [],
    corners: [
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
    extent: { west: 0, east: 1, south: 0, north: 1 },
  };

  it("paints each band's colour with the edge fade as alpha", () => {
    const rgba = paintRaster(r, [
      [10, 20, 30],
      [40, 50, 60],
    ]);
    expect(rgba).toHaveLength(12);
    expect([...rgba.slice(0, 4)]).toEqual([10, 20, 30, 255]);
    expect([...rgba.slice(4, 8)]).toEqual([40, 50, 60, 128]);
  });

  it("makes a pixel with no band fully transparent", () => {
    const rgba = paintRaster(r, [
      [10, 20, 30],
      [40, 50, 60],
    ]);
    expect([...rgba.slice(8, 12)]).toEqual([0, 0, 0, 0]);
  });

  it("leaves a band without a palette colour transparent rather than guessing one", () => {
    const rgba = paintRaster(r, [[10, 20, 30]]);
    expect(rgba[4 + 3]).toBe(0);
  });
});

describe("contourLines", () => {
  /** A raster whose field is exactly `values` (row-major), nothing else matters. */
  function rasterOf(
    width: number,
    height: number,
    values: number[],
    levels: number[],
  ): FieldRaster {
    return {
      width,
      height,
      bands: new Int8Array(width * height),
      alpha: new Uint8ClampedArray(width * height).fill(255),
      values: Float32Array.from(values),
      tokens: [],
      levels,
      corners: [
        [0, 1],
        [1, 1],
        [1, 0],
        [0, 0],
      ],
      extent: { west: 0, east: 2, south: 0, north: 0.0001 },
    };
  }

  it("draws no line where the field never reaches the level", () => {
    const fc = contourLines(rasterOf(2, 2, [1, 2, 3, 4], [10]));
    expect(fc.features).toHaveLength(0);
    expect(
      contourLines(rasterOf(2, 2, [11, 12, 13, 14], [10])).features,
    ).toHaveLength(0);
  });

  it("crosses a ramp where the ramp reaches the level", () => {
    // 4 x 2 raster, value = column * 10: level 15 falls between columns 1 and 2.
    const fc = contourLines(
      rasterOf(4, 2, [0, 10, 20, 30, 0, 10, 20, 30], [15]),
    );
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties.level).toBe(15);
    const lines = fc.features[0].geometry.coordinates;
    expect(lines.length).toBeGreaterThan(0);
    // Column 1.5 of a 4-wide, 2-degree-wide raster: lon = ((1.5 + 0.5) / 4) * 2 = 1.
    for (const line of lines) {
      for (const [lon] of line) expect(lon).toBeCloseTo(1, 4);
    }
  });

  it("emits the right number of segments for every marching-squares case", () => {
    // One 2 x 2 cell, corners tl, tr, bl, br; level 5, corners 10 (high) or 0 (low).
    const expected: Record<number, number> = {
      0: 0,
      1: 1,
      2: 1,
      3: 1,
      4: 1,
      5: 2,
      6: 1,
      7: 1,
      8: 1,
      9: 1,
      10: 2,
      11: 1,
      12: 1,
      13: 1,
      14: 1,
      15: 0,
    };
    for (let code = 0; code < 16; code++) {
      const tl = code & 8 ? 10 : 0;
      const tr = code & 4 ? 10 : 0;
      const br = code & 2 ? 10 : 0;
      const bl = code & 1 ? 10 : 0;
      const fc = contourLines(rasterOf(2, 2, [tl, tr, bl, br], [5]));
      const count = fc.features[0]?.geometry.coordinates.length ?? 0;
      expect(count, `case ${code}`).toBe(expected[code]);
    }
  });

  it("splits a saddle by its centre, so two high corners join only when the middle is high", () => {
    // tl and br high. Mean 5 >= level 5 -> connected highs; lower the level to split.
    const joined = contourLines(rasterOf(2, 2, [10, 0, 0, 10], [5]));
    expect(joined.features[0].geometry.coordinates).toHaveLength(2);
    const apart = contourLines(rasterOf(2, 2, [10, 0, 0, 10], [5.5]));
    expect(apart.features[0].geometry.coordinates).toHaveLength(2);
    // Both give two segments, but around different corners.
    expect(JSON.stringify(joined.features[0].geometry)).not.toBe(
      JSON.stringify(apart.features[0].geometry),
    );
  });

  it("stops the outline where the fill starts to fade, so no line ends hard at the box's edge", () => {
    // Bands that run west to east across the whole box: the lines would reach
    // the very edge of the image if the fade zone were not skipped.
    const g = gridOf(workerGrid(0, 0, 40, 7, (row) => row * 20));
    const r = buildFieldRaster(g, {
      classify: (v) => (v >= 30 ? 1 : 0),
      tokens: ["--a", "--b"],
      levels: [30],
      side: 96,
    });
    const fc = contourLines(r);
    expect(fc.features).toHaveLength(1);
    const cell = (r.extent.east - r.extent.west) / 7;
    const pixel = (r.extent.east - r.extent.west) / r.width;
    // Half a cell in from each edge (the outermost samples), give or take a pixel.
    const lons = fc.features[0].geometry.coordinates.flat().map(([lon]) => lon);
    expect(Math.min(...lons)).toBeGreaterThanOrEqual(
      r.extent.west + cell / 2 - 2 * pixel,
    );
    expect(Math.max(...lons)).toBeLessThanOrEqual(
      r.extent.east - cell / 2 + 2 * pixel,
    );
    // ... yet it still crosses most of the box.
    expect(Math.max(...lons) - Math.min(...lons)).toBeGreaterThan(cell * 4);
    // Every pixel the outline touches is at least half opaque.
    expect(CONTOUR_MIN_ALPHA).toBe(featherAlpha(0.5));
    expect(CONTOUR_MIN_ALPHA).toBeGreaterThanOrEqual(120);
    expect(CONTOUR_MIN_ALPHA).toBeLessThanOrEqual(136);
  });

  it("skips cells that touch a hole", () => {
    const fc = contourLines(
      rasterOf(3, 2, [0, Number.NaN, 20, 0, 10, 20], [5]),
    );
    // The left cell touches the NaN (skipped); the right cell touches it too.
    expect(fc.features).toHaveLength(0);
  });

  it("outlines the boundaries of a raster built from a real grid, one level per band edge", () => {
    const g = gridOf(workerGrid(0, 0, 40, 7, (_, c) => c * 20));
    const r = buildFieldRaster(g, {
      classify: (v) => (v >= 30 ? (v >= 70 ? 2 : 1) : 0),
      tokens: ["--a", "--b", "--c"],
      levels: [30, 70],
      side: 96,
    });
    const fc = contourLines(r);
    expect(fc.features.map((f) => f.properties.level)).toEqual([30, 70]);
    for (const f of fc.features) {
      for (const line of f.geometry.coordinates) {
        for (const [lon, lat] of line) {
          expect(lon).toBeGreaterThanOrEqual(r.extent.west - 1e-6);
          expect(lon).toBeLessThanOrEqual(r.extent.east + 1e-6);
          expect(lat).toBeGreaterThanOrEqual(r.extent.south - 1e-6);
          expect(lat).toBeLessThanOrEqual(r.extent.north + 1e-6);
        }
      }
    }
  });
});
