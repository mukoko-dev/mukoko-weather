/**
 * Smooth, banded rasters for the coarse forecast grids on the full-screen map.
 *
 * The Workers answer a 7x7 grid (air quality: 13 km apart, model fields: 40 km
 * apart). Painting one flat square per sample reads as a few big blocks. This
 * module fills the space BETWEEN the samples instead: it interpolates the grid
 * onto a finer lat/lon raster, classifies every fine cell into the SAME legend
 * band the legend and weather-scales.ts define (so a legend swatch and the map
 * still match: the bands stay discrete, there is no new continuous ramp), and
 * hands back plain typed arrays that a single MapLibre image source draws.
 *
 * Interpolation adds smoothness, not information. The grid is still 49 samples
 * from models that are 9 to 25 km wide; the raster only stops the grid's own
 * spacing from showing as square corners. Nothing here asks for more data.
 *
 * Everything in this file is pure (typed arrays in, typed arrays out) and runs
 * in node. Only the last step, handing the pixels to MapLibre, touches the DOM
 * (MapLibreMap.tsx).
 *
 * Rules the tests pin:
 *  - the value at a sample point is the sample;
 *  - between samples a value never leaves the range of its four neighbours
 *    (monotone cubic: no overshoot, so no band the data never reached);
 *  - a missing sample leaves a hole, never a zero;
 *  - the alpha fades to nothing over one source cell at the box's edge, so no
 *    hard rectangle is left;
 *  - the image is bounded (MAX_RASTER_SIDE).
 */

import type { Feature, FeatureCollection, MultiLineString } from "geojson";
import { isConstrainedDevice, readDeviceHints } from "./lazy-visibility";

/* ------------------------------------------------------------------------ *
 * Sample grid
 * ------------------------------------------------------------------------ */

/** One reading at one point. `value: null` is a missing reading. */
export interface FieldSample {
  lat: number;
  lon: number;
  value: number | null;
}

/**
 * A rectilinear grid of readings: rows run south to north, columns west to
 * east. `lons` are unwrapped around the first sample, so a grid that crosses
 * the antimeridian has longitudes past 180 (or below -180) and stays regular.
 */
export interface SampleGrid {
  /** Ascending latitudes, one per row. */
  lats: number[];
  /** Ascending, unwrapped longitudes, one per column. */
  lons: number[];
  /** Row-major (`row * lons.length + col`); null where there is no reading. */
  values: (number | null)[];
}

/** Two coordinates closer than this are one grid line (about 11 m). */
const GRID_TOLERANCE_DEG = 1e-4;
/** The Workers send at most 9 x 9; anything bigger is not their grid. */
const MAX_GRID_SIDE = 33;

/** Longitude difference wrapped into [-180, 180). */
function wrapDelta(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** Sorted values with neighbours within the tolerance merged into their mean. */
function gridLines(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const lines: number[][] = [];
  for (const v of sorted) {
    const last = lines[lines.length - 1];
    if (last && v - last[last.length - 1] <= GRID_TOLERANCE_DEG) last.push(v);
    else lines.push([v]);
  }
  return lines.map((l) => l.reduce((s, v) => s + v, 0) / l.length);
}

/** Index of the line nearest `v` in an ascending list. */
function nearestIndex(lines: readonly number[], v: number): number {
  let best = 0;
  for (let i = 1; i < lines.length; i++) {
    if (Math.abs(lines[i] - v) < Math.abs(lines[best] - v)) best = i;
  }
  return best;
}

/**
 * Structures scattered samples as a grid. The Workers lay their grids out on
 * regular latitude and longitude lines (the longitude step is corrected once,
 * for the centre's latitude), so every row shares its latitude and every
 * column its longitude. Returns null when there is no 2 x 2 grid to speak of
 * (fewer than two rows or columns, or a grid this app never asks for), so the
 * caller simply paints nothing.
 */
export function sampleGridFrom(
  samples: readonly FieldSample[],
): SampleGrid | null {
  const usable = samples.filter(
    (s) => Number.isFinite(s.lat) && Number.isFinite(s.lon),
  );
  if (usable.length < 4) return null;
  const ref = usable[0].lon;
  const unwrapped = usable.map((s) => ref + wrapDelta(s.lon - ref));
  const lats = gridLines(usable.map((s) => s.lat));
  const lons = gridLines(unwrapped);
  if (
    lats.length < 2 ||
    lons.length < 2 ||
    lats.length > MAX_GRID_SIDE ||
    lons.length > MAX_GRID_SIDE
  ) {
    return null;
  }
  const values: (number | null)[] = new Array(lats.length * lons.length).fill(
    null,
  );
  usable.forEach((s, k) => {
    const row = nearestIndex(lats, s.lat);
    const col = nearestIndex(lons, unwrapped[k]);
    const v = s.value;
    values[row * lons.length + col] =
      v !== null && v !== undefined && Number.isFinite(v) ? v : null;
  });
  return { lats, lons, values };
}

/** True when at least one reading is present (an all-null grid has nothing to draw). */
export function hasReadings(grid: SampleGrid): boolean {
  return grid.values.some((v) => v !== null);
}

/* ------------------------------------------------------------------------ *
 * Interpolation
 * ------------------------------------------------------------------------ */

/** Interval index and 0..1 position of `v` on an ascending axis (clamped to its ends). */
function locate(axis: readonly number[], v: number): { i: number; t: number } {
  const last = axis.length - 2;
  if (v <= axis[0]) return { i: 0, t: 0 };
  if (v >= axis[axis.length - 1]) return { i: last, t: 1 };
  let i = 0;
  while (i < last && v > axis[i + 1]) i++;
  return { i, t: (v - axis[i]) / (axis[i + 1] - axis[i]) };
}

/**
 * Slope of the monotone cubic (Fritsch-Carlson, uniform spacing) at `b`, from
 * its neighbours. A missing neighbour (the grid's edge or a null reading)
 * falls back to the one secant there is; at a local extremum the slope is 0,
 * which is what keeps the curve from overshooting.
 */
function monotoneSlope(
  a: number | undefined,
  b: number,
  c: number | undefined,
): number {
  if (a === undefined && c === undefined) return 0;
  if (a === undefined) return (c as number) - b;
  if (c === undefined) return b - a;
  const left = b - a;
  const right = c - b;
  if (left * right <= 0) return 0;
  return (2 * left * right) / (left + right);
}

/** Cubic Hermite between p0 and p1 at t, with slopes from the neighbours. */
function monotoneCubic(
  before: number | undefined,
  p0: number,
  p1: number,
  after: number | undefined,
  t: number,
): number {
  const m0 = monotoneSlope(before, p0, p1);
  const m1 = monotoneSlope(p0, p1, after);
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * p0 +
    (t3 - 2 * t2 + t) * m0 +
    (-2 * t3 + 3 * t2) * p1 +
    (t3 - t2) * m1
  );
}

function readingAt(
  grid: SampleGrid,
  row: number,
  col: number,
): number | undefined {
  const cols = grid.lons.length;
  if (row < 0 || row >= grid.lats.length || col < 0 || col >= cols)
    return undefined;
  return grid.values[row * cols + col] ?? undefined;
}

/**
 * The field at a point: the grid interpolated between its four surrounding
 * readings, or NaN where there is none.
 *
 *  - Four readings around: tensor-product monotone cubic. It passes through
 *    every reading and never leaves the range of the four corners, but its
 *    contours are smooth across the grid lines (a bilinear surface bends at
 *    every one of them, which reads as a diamond around each peak).
 *  - A reading missing at a corner: the remaining corners, weighted bilinearly,
 *    and a HOLE (NaN) once the missing readings carry half the weight or more,
 *    so a missing reading blanks about its own cell and nothing is invented
 *    over it. Never zero.
 *  - Outside the grid (the half-cell margin): the nearest edge value.
 */
export function interpolateAt(
  grid: SampleGrid,
  lat: number,
  lon: number,
): number {
  const { i: row, t: ty } = locate(grid.lats, lat);
  const { i: col, t: tx } = locate(grid.lons, lon);
  const corners = [
    readingAt(grid, row, col),
    readingAt(grid, row, col + 1),
    readingAt(grid, row + 1, col),
    readingAt(grid, row + 1, col + 1),
  ];
  const weights = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
  let missing = 0;
  let sum = 0;
  let present = 0;
  corners.forEach((c, k) => {
    if (c === undefined) {
      missing += weights[k];
    } else {
      sum += c * weights[k];
      present += weights[k];
    }
  });
  if (missing >= 0.5 || present <= 0) return Number.NaN;
  if (missing > 0) return sum / present;

  const along = (r: number): number | undefined => {
    const left = readingAt(grid, r, col);
    const right = readingAt(grid, r, col + 1);
    if (left === undefined || right === undefined) return undefined;
    return monotoneCubic(
      readingAt(grid, r, col - 1),
      left,
      right,
      readingAt(grid, r, col + 2),
      tx,
    );
  };
  return monotoneCubic(
    along(row - 1),
    along(row) as number,
    along(row + 1) as number,
    along(row + 2),
    ty,
  );
}

/* ------------------------------------------------------------------------ *
 * Web Mercator rows
 * ------------------------------------------------------------------------ */

/** The latitude where Web Mercator ends; MapLibre draws nothing beyond it. */
const MAX_MERCATOR_LAT = 85.0511287798;
const RAD = Math.PI / 180;

/** Web Mercator y (radians) of a latitude, clamped to the map's extent. */
export function mercatorY(lat: number): number {
  const phi =
    Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat)) * RAD;
  return Math.log(Math.tan(Math.PI / 4 + phi / 2));
}

/** Inverse of `mercatorY`. */
export function latFromMercatorY(y: number): number {
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD;
}

/* ------------------------------------------------------------------------ *
 * The raster
 * ------------------------------------------------------------------------ */

/** Larger side of the image on a normal device. */
export const RASTER_SIDE = 96;
/** Larger side on a constrained device (Save-Data, 2 GB RAM or less). */
export const RASTER_SIDE_CONSTRAINED = 64;
/** Hard cap on either side, whatever a caller asks for. */
export const MAX_RASTER_SIDE = 128;
/** The alpha fades in over this many source cells from the box's edge. */
export const FEATHER_CELLS = 1;
/** Marks a pixel with no colour (a hole, or below the legend's first band). */
export const NO_BAND = -1;

/** Image corners as MapLibre wants them: top-left, top-right, bottom-right, bottom-left. */
export type ImageCorners = [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
];

export interface FieldRaster {
  width: number;
  height: number;
  /** Legend band per pixel, row-major from the top-left; NO_BAND for none. */
  bands: Int8Array;
  /** Edge fade per pixel, 0..255; the picture's own opacity is applied on top. */
  alpha: Uint8ClampedArray;
  /** The interpolated field per pixel (NaN where there is no reading). */
  values: Float32Array;
  /** CSS custom property per band (resolved when painting; paint cannot read var()). */
  tokens: readonly string[];
  /** Values where one band ends and the next starts, for outline contours. */
  levels: readonly number[];
  corners: ImageCorners;
  extent: { west: number; east: number; south: number; north: number };
}

export interface FieldRasterSpec {
  /** Maps a field value to its legend band, or NO_BAND (e.g. drizzle under the first band). */
  classify: (value: number) => number;
  tokens: readonly string[];
  /** Band boundaries as field values (used for the outline contours). */
  levels?: readonly number[];
  /** Larger side of the image in pixels; defaults to `defaultRasterSide()`. */
  side?: number;
}

/** The larger image side for this device. */
export function defaultRasterSide(): number {
  return isConstrainedDevice(readDeviceHints())
    ? RASTER_SIDE_CONSTRAINED
    : RASTER_SIDE;
}

/** Mean spacing of an ascending axis. */
function meanGap(axis: readonly number[]): number {
  return (axis[axis.length - 1] - axis[0]) / (axis.length - 1);
}

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

/** Fade (0..255) for a point `cells` source cells in from the nearest edge. */
export function featherAlpha(cells: number): number {
  return Math.round(255 * smoothstep(cells / FEATHER_CELLS));
}

/**
 * The raster for a grid: the box the old square cells covered (the samples and
 * half a cell around them), interpolated onto `side` pixels, classified, and
 * faded at the edge. Rows are spaced evenly in Web Mercator y, which is how
 * MapLibre stretches an image over its corners, so a pixel lands where its
 * latitude is.
 */
export function buildFieldRaster(
  grid: SampleGrid,
  spec: FieldRasterSpec,
): FieldRaster {
  const { lats, lons } = grid;
  const gapLat = meanGap(lats);
  const gapLon = meanGap(lons);
  // Half a cell past the outermost samples: the box the square cells covered.
  const south = Math.max(-MAX_MERCATOR_LAT, lats[0] - (lats[1] - lats[0]) / 2);
  const north = Math.min(
    MAX_MERCATOR_LAT,
    lats[lats.length - 1] + (lats[lats.length - 1] - lats[lats.length - 2]) / 2,
  );
  const west = lons[0] - (lons[1] - lons[0]) / 2;
  const east =
    lons[lons.length - 1] + (lons[lons.length - 1] - lons[lons.length - 2]) / 2;

  const yNorth = mercatorY(north);
  const ySouth = mercatorY(south);
  const ratio = ((east - west) * RAD) / (yNorth - ySouth);
  const side = Math.max(
    8,
    Math.min(MAX_RASTER_SIDE, Math.round(spec.side ?? defaultRasterSide())),
  );
  const width = ratio >= 1 ? side : Math.max(2, Math.round(side * ratio));
  const height = ratio >= 1 ? Math.max(2, Math.round(side / ratio)) : side;

  const bands = new Int8Array(width * height).fill(NO_BAND);
  const alpha = new Uint8ClampedArray(width * height);
  const values = new Float32Array(width * height).fill(Number.NaN);

  for (let py = 0; py < height; py++) {
    const lat = latFromMercatorY(
      yNorth + ((py + 0.5) / height) * (ySouth - yNorth),
    );
    const edgeLat = Math.min(lat - south, north - lat) / gapLat;
    for (let px = 0; px < width; px++) {
      const lon = west + ((px + 0.5) / width) * (east - west);
      const edgeLon = Math.min(lon - west, east - lon) / gapLon;
      const at = py * width + px;
      alpha[at] = featherAlpha(Math.min(edgeLat, edgeLon));
      const v = interpolateAt(grid, lat, lon);
      if (Number.isNaN(v)) continue;
      values[at] = v;
      bands[at] = spec.classify(v);
    }
  }

  return {
    width,
    height,
    bands,
    alpha,
    values,
    tokens: spec.tokens,
    levels: spec.levels ?? [],
    corners: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
    extent: { west, east, south, north },
  };
}

/* ------------------------------------------------------------------------ *
 * Painting
 * ------------------------------------------------------------------------ */

export type Rgb = readonly [number, number, number];

function channel(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * RGB of a CSS colour written as hex (3, 4, 6 or 8 digits) or `rgb()` /
 * `rgba()`, which is what `getComputedStyle` returns for the --wx-* tokens.
 * Null for anything else; the caller decides what to do (MapLibreMap asks the
 * browser to convert it).
 */
export function parseCssColor(css: string): Rgb | null {
  const s = css.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    const h =
      hex[1].length <= 4
        ? hex[1]
            .split("")
            .map((c) => c + c)
            .join("")
        : hex[1];
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (rgb) return [channel(+rgb[1]), channel(+rgb[2]), channel(+rgb[3])];
  return null;
}

/**
 * The raster as RGBA bytes (row-major, straight alpha): each pixel takes its
 * band's colour with the edge fade as alpha; a pixel with no band (a hole, or
 * below the legend's first band) is fully transparent. The layer's own opacity
 * is NOT baked in, so MapLibre's `raster-opacity` stays the one place it lives.
 */
export function paintRaster(
  raster: FieldRaster,
  palette: readonly Rgb[],
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(new ArrayBuffer(raster.bands.length * 4));
  for (let i = 0; i < raster.bands.length; i++) {
    const band = raster.bands[i];
    const colour = band >= 0 ? palette[band] : undefined;
    if (!colour) continue;
    out[i * 4] = colour[0];
    out[i * 4 + 1] = colour[1];
    out[i * 4 + 2] = colour[2];
    out[i * 4 + 3] = raster.alpha[i];
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * Band-edge contours
 * ------------------------------------------------------------------------ */

type Edge = "top" | "right" | "bottom" | "left";

/**
 * Marching squares: which edges of a cell the contour crosses, by the corners
 * at or above the level (bit 8 top-left, 4 top-right, 2 bottom-right, 1
 * bottom-left). The two saddles (5 and 10) are split by the cell's centre.
 */
function cellSegments(code: number, centreHigh: boolean): [Edge, Edge][] {
  switch (code) {
    case 1:
    case 14:
      return [["left", "bottom"]];
    case 2:
    case 13:
      return [["right", "bottom"]];
    case 3:
    case 12:
      return [["left", "right"]];
    case 4:
    case 11:
      return [["top", "right"]];
    case 6:
    case 9:
      return [["top", "bottom"]];
    case 7:
    case 8:
      return [["top", "left"]];
    case 5:
      return centreHigh
        ? [
            ["top", "left"],
            ["right", "bottom"],
          ]
        : [
            ["top", "right"],
            ["left", "bottom"],
          ];
    case 10:
      return centreHigh
        ? [
            ["top", "right"],
            ["left", "bottom"],
          ]
        : [
            ["top", "left"],
            ["right", "bottom"],
          ];
    default:
      return [];
  }
}

/** Longitude and latitude of a pixel-centre position (x, y in pixels). */
function pixelToLonLat(
  raster: FieldRaster,
  x: number,
  y: number,
): [number, number] {
  const { west, east, south, north } = raster.extent;
  const yNorth = mercatorY(north);
  const ySouth = mercatorY(south);
  const lon = west + ((x + 0.5) / raster.width) * (east - west);
  const lat = latFromMercatorY(
    yNorth + ((y + 0.5) / raster.height) * (ySouth - yNorth),
  );
  return [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];
}

/**
 * An outline is drawn only where the fill is at least this opaque (of 255):
 * from the outermost samples inward. In the fade zone beyond them the colour
 * is dissolving, and a line that kept going would end hard at the box's edge,
 * which is exactly the rectangle the fade removes.
 */
export const CONTOUR_MIN_ALPHA = featherAlpha(0.5);

/**
 * Thin outlines where one band ends and the next starts: iso-lines of the
 * interpolated field at each of the raster's `levels`, as one MultiLineString
 * per level. They replace the old outline around every square cell, and they
 * are why the data fill still carries the theme-aware --wx-outline (the
 * official fills cannot all hold 3:1 against the base map). A vector layer
 * keeps them one screen pixel wide at every zoom, which a line baked into the
 * image could not. Cells touching a hole, or the edge fade, are skipped.
 */
export function contourLines(
  raster: FieldRaster,
): FeatureCollection<MultiLineString, { level: number }> {
  const { width, height, values, alpha } = raster;
  const features: Feature<MultiLineString, { level: number }>[] = [];

  for (const level of raster.levels) {
    const lines: [number, number][][] = [];
    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width - 1; x++) {
        const tl = values[y * width + x];
        const tr = values[y * width + x + 1];
        const bl = values[(y + 1) * width + x];
        const br = values[(y + 1) * width + x + 1];
        if (
          Number.isNaN(tl) ||
          Number.isNaN(tr) ||
          Number.isNaN(bl) ||
          Number.isNaN(br)
        ) {
          continue;
        }
        if (
          alpha[y * width + x] < CONTOUR_MIN_ALPHA ||
          alpha[y * width + x + 1] < CONTOUR_MIN_ALPHA ||
          alpha[(y + 1) * width + x] < CONTOUR_MIN_ALPHA ||
          alpha[(y + 1) * width + x + 1] < CONTOUR_MIN_ALPHA
        ) {
          continue;
        }
        const code =
          (tl >= level ? 8 : 0) |
          (tr >= level ? 4 : 0) |
          (br >= level ? 2 : 0) |
          (bl >= level ? 1 : 0);
        if (code === 0 || code === 15) continue;
        const crossing = (a: number, b: number) => (level - a) / (b - a);
        const at = (edge: Edge): [number, number] => {
          switch (edge) {
            case "top":
              return pixelToLonLat(raster, x + crossing(tl, tr), y);
            case "bottom":
              return pixelToLonLat(raster, x + crossing(bl, br), y + 1);
            case "left":
              return pixelToLonLat(raster, x, y + crossing(tl, bl));
            case "right":
              return pixelToLonLat(raster, x + 1, y + crossing(tr, br));
          }
        };
        const centreHigh = (tl + tr + bl + br) / 4 >= level;
        for (const [from, to] of cellSegments(code, centreHigh)) {
          lines.push([at(from), at(to)]);
        }
      }
    }
    if (lines.length > 0) {
      features.push({
        type: "Feature",
        properties: { level },
        geometry: { type: "MultiLineString", coordinates: lines },
      });
    }
  }
  return { type: "FeatureCollection", features };
}
