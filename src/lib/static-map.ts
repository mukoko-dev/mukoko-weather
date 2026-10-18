/**
 * Static map preview built from MapTiler raster tiles (#266).
 *
 * The location page's map card is a non-interactive thumbnail that links to
 * the full map. Rendering it with MapLibre cost ~285 KB (gzip) of JavaScript,
 * a 147 KB worker, the style, two sprites, four glyph ranges and the vector
 * tiles (~535 KB after the JS) just to draw one square. Four 512 px raster
 * tiles (~60 KB together) placed in an SVG show the same view with no map
 * library at all. MapTiler's Static Maps API is not enabled for the key, but
 * its raster tiles are.
 *
 * Pure geometry: given a centre and zoom, return the 2×2 block of tiles that
 * covers a square view around the centre and the SVG viewBox that frames it.
 */

/** MapTiler raster tiles are 512 px; their zoom matches MapLibre's zoom. */
export const STATIC_TILE_SIZE = 512;

/** World-pixel width of the preview square (≈ the card width on a phone). */
export const STATIC_VIEW_SIZE = 400;

export interface StaticTile {
  href: string;
  /** Top-left corner in world pixels at the requested zoom. */
  x: number;
  y: number;
}

export interface StaticMap {
  /**
   * SVG viewBox ("minX minY width height") centred on the location, shifted
   * only as far as needed to stay inside the world (near the poles).
   */
  viewBox: string;
  /** The location in world pixels (where the marker goes). */
  cx: number;
  cy: number;
  tiles: StaticTile[];
}

/** Web Mercator world pixel for a coordinate at `zoom` (512 px tiles). */
export function worldPixel(
  lat: number,
  lon: number,
  zoom: number,
): { x: number; y: number } {
  const scale = STATIC_TILE_SIZE * 2 ** zoom;
  // Mercator is undefined at the poles; clamp to its usual limit.
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const sin = Math.sin((clampedLat * Math.PI) / 180);
  const x = ((lon + 180) / 360) * scale;
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
  return { x, y };
}

/**
 * MapTiler raster tile URL. `retina` adds the documented `@2x` suffix: the same
 * area and content as the plain tile with twice the pixels in each direction,
 * so the SVG geometry does not change.
 */
export function rasterTileUrl(
  style: string,
  z: number,
  x: number,
  y: number,
  key: string,
  retina = false,
): string {
  // Trimmed here too (MAPTILER_KEY already is): an encoded stray newline
  // (%0A) makes MapTiler answer "Invalid key".
  return `https://api.maptiler.com/maps/${style}/${z}/${x}/${y}${retina ? "@2x" : ""}.png?key=${encodeURIComponent(key.trim())}`;
}

/** Whether a screen is dense enough that the plain tiles look soft. */
export function wantsRetinaTiles(
  devicePixelRatio: number | undefined,
): boolean {
  return (devicePixelRatio ?? 1) >= 1.5;
}

/**
 * True only when every tile of the picture has failed. One bad tile (a blip,
 * a tile outside coverage) must not wipe the whole map: the others still draw
 * and the failed one shows the card background.
 */
export function allTilesFailed(
  map: StaticMap,
  failed: ReadonlySet<string>,
): boolean {
  return map.tiles.length > 0 && map.tiles.every((t) => failed.has(t.href));
}

/**
 * The 2×2 tiles around the centre. The block starts on whichever side of the
 * centre tile is nearer, so the view square (smaller than a tile) always
 * fits inside it. Columns wrap around the antimeridian; rows are clamped.
 */
export function staticMapTiles(opts: {
  lat: number;
  lon: number;
  zoom: number;
  style: string;
  apiKey: string;
  viewSize?: number;
  /** Request `@2x` tiles (same geometry, sharper on high-DPI screens). */
  retina?: boolean;
}): StaticMap {
  const { lat, lon, zoom, style, apiKey } = opts;
  const view = opts.viewSize ?? STATIC_VIEW_SIZE;
  const z = Math.max(0, Math.round(zoom));
  const n = 2 ** z;
  const world = n * STATIC_TILE_SIZE;
  const half = view / 2;
  const { x: cx, y: cy } = worldPixel(lat, lon, z);
  // The view is centred on the location, but near the poles that would reach
  // past the top or bottom of the world, where there is no tile: keep the whole
  // square inside it (the marker stays on the real position). Columns wrap, so
  // x needs no clamp.
  const vy =
    world <= view ? world / 2 : Math.max(half, Math.min(world - half, cy));
  const tx = Math.floor(cx / STATIC_TILE_SIZE);
  const ty = Math.floor(vy / STATIC_TILE_SIZE);
  // A single-tile world (z0) has no neighbour to start from.
  const x0 =
    n === 1
      ? 0
      : cx - tx * STATIC_TILE_SIZE < STATIC_TILE_SIZE / 2
        ? tx - 1
        : tx;
  const yNear = vy - ty * STATIC_TILE_SIZE < STATIC_TILE_SIZE / 2 ? ty - 1 : ty;
  const y0 = Math.max(0, Math.min(Math.max(0, n - 2), yNear));

  const tiles: StaticTile[] = [];
  for (let dy = 0; dy < Math.min(2, n); dy++) {
    for (let dx = 0; dx < Math.min(2, n); dx++) {
      const col = x0 + dx;
      const row = y0 + dy;
      const wrapped = ((col % n) + n) % n;
      tiles.push({
        href: rasterTileUrl(style, z, wrapped, row, apiKey, opts.retina),
        x: col * STATIC_TILE_SIZE,
        y: row * STATIC_TILE_SIZE,
      });
    }
  }
  return {
    viewBox: `${cx - half} ${vy - half} ${view} ${view}`,
    cx,
    cy,
    tiles,
  };
}
