/**
 * Smoothing for map tiles whose data is made of hard square cells.
 *
 * NASA IMERG precipitation (the "Rain (satellite)" layer) is a 0.1 degree grid,
 * about 11 km. GIBS draws it into its 256 px tiles as nearest-neighbour cells,
 * 4 to 5 px wide at tile zoom 6, so the map shows a mosaic of squares that
 * grows to 36 px a side at map zoom 8. The cells are the data's real size and
 * nothing here adds detail; this only draws the field the way every weather
 * map does, as soft shapes instead of boxes.
 *
 * How: a tile is blurred with a Gaussian about the size of one cell
 * (`SMOOTH_SIGMA_PER_CELL` of it), with premultiplied alpha, so that dry
 * ground fades out softly instead of leaving a coloured fringe. The blur reads
 * a margin from the eight neighbouring tiles, so a cell that straddles a tile
 * edge is smoothed the same on both sides and there is no seam.
 *
 * Everything here is pure (no DOM, no network) and unit-tested. The browser
 * side (fetching, decoding, MapLibre's protocol hook) is smooth-tile-protocol.ts.
 */

/** MapLibre protocol name; a smoothed tile's URL is `mksmooth://<cell>/<real url>`. */
export const SMOOTH_PROTOCOL = "mksmooth";

/**
 * Gaussian sigma as a share of one data cell. With no opacity boost, the
 * blurred alpha of a straight cell edge is exactly one half where the edge was,
 * so the rain's visible boundary stays where the data put it. 0.4 cell keeps a
 * lone cell at about 60% opacity at its centre and rounds a corner by about
 * half a cell; wider blurs wash lone cells out, narrower ones leave boxes.
 */
export const SMOOTH_SIGMA_PER_CELL = 0.4;

/**
 * The smoothed tile is made this many times finer than the provider's. Sampled
 * finely and edge to edge (sampleTileEdgeToEdge), two neighbouring tiles agree
 * exactly on their shared border, so no seam shows where MapLibre clamps each
 * texture. The picture is the same field, not a more detailed one.
 */
export const SMOOTH_UPSCALE = 2;

/** Below this sigma (in pixels) a blur changes nothing visible; the tile is used as is. */
export const MIN_SIGMA_PX = 0.35;

/** Tile edge, in pixels, of every WMTS layer we smooth. */
export const SMOOTH_TILE_SIZE = 256;

/**
 * The URL MapLibre is given for a smoothed tile. `cellDegrees` is the data
 * cell's size, which sets the blur; the real URL keeps its `{z}/{y}/{x}`
 * placeholders for MapLibre to fill.
 */
export function smoothTileUrl(url: string, cellDegrees: number): string {
  return `${SMOOTH_PROTOCOL}://${cellDegrees}/${url}`;
}

/** The pieces of a smoothed tile URL, or null when it is not one of ours. */
export function parseSmoothTileUrl(
  url: string,
): { url: string; cellDegrees: number } | null {
  const prefix = `${SMOOTH_PROTOCOL}://`;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const cellDegrees = Number(rest.slice(0, slash));
  const real = rest.slice(slash + 1);
  if (!Number.isFinite(cellDegrees) || cellDegrees <= 0) return null;
  if (!/^https:\/\//.test(real)) return null;
  return { url: real, cellDegrees };
}

/** A WMTS REST tile address: `<prefix><z>/<y>/<x><suffix>`. */
export interface WmtsTile {
  prefix: string;
  z: number;
  y: number;
  x: number;
  suffix: string;
}

/** Splits a WMTS REST tile URL (`…/{z}/{y}/{x}.png`) into its address, or null. */
export function parseWmtsTile(url: string): WmtsTile | null {
  const m = /^(.*\/)(\d+)\/(\d+)\/(\d+)(\.[a-z]+(?:\?.*)?)$/i.exec(url);
  if (!m) return null;
  const z = Number(m[2]);
  const y = Number(m[3]);
  const x = Number(m[4]);
  const n = 2 ** z;
  if (!Number.isInteger(z) || z < 0 || z > 24) return null;
  if (y >= n || x >= n) return null;
  return { prefix: m[1], z, y, x, suffix: m[5] };
}

/**
 * The nine tiles around (and including) `url`, row by row from the north-west:
 * index 4 is the tile itself. A tile past the north or south pole does not
 * exist (null); east and west wrap around the date line. Null for a URL that
 * is not a WMTS tile address.
 */
export function neighbourTileUrls(url: string): (string | null)[] | null {
  const t = parseWmtsTile(url);
  if (!t) return null;
  const n = 2 ** t.z;
  const out: (string | null)[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const y = t.y + dy;
      if (y < 0 || y >= n) {
        out.push(null);
        continue;
      }
      const x = (((t.x + dx) % n) + n) % n;
      out.push(`${t.prefix}${t.z}/${y}/${x}${t.suffix}`);
    }
  }
  return out;
}

/** Pixels one data cell spans along the tile's x axis at tile zoom `z`. */
export function cellPixels(
  cellDegrees: number,
  z: number,
  tileSize = SMOOTH_TILE_SIZE,
): number {
  return (cellDegrees / 360) * tileSize * 2 ** z;
}

/** The blur for a layer's cell size at tile zoom `z`, in tile pixels. */
export function smoothSigma(
  cellDegrees: number,
  z: number,
  tileSize = SMOOTH_TILE_SIZE,
): number {
  return SMOOTH_SIGMA_PER_CELL * cellPixels(cellDegrees, z, tileSize);
}

/** Normalised Gaussian weights, `2 * ceil(3 * sigma) + 1` of them. */
export function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = w;
    sum += w;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/** Margin (pixels) a blur of this sigma reads past a tile's edge. */
export function blurMargin(sigma: number): number {
  return Math.max(1, Math.ceil(3 * sigma));
}

/**
 * Gaussian blur of straight-alpha RGBA pixels, done on premultiplied colour so
 * a transparent neighbour lowers the alpha without darkening or greying the
 * colour. Pixels past the image are transparent. Returns straight-alpha RGBA.
 */
export function blurRgba(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  sigma: number,
): Uint8ClampedArray {
  const kernel = gaussianKernel(sigma);
  const radius = (kernel.length - 1) / 2;
  const count = width * height;

  // Premultiplied, as floats: r*a, g*a, b*a in 0..255 and alpha in 0..255.
  const a = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const alpha = src[i * 4 + 3];
    const f = alpha / 255;
    a[i * 4] = src[i * 4] * f;
    a[i * 4 + 1] = src[i * 4 + 1] * f;
    a[i * 4 + 2] = src[i * 4 + 2] * f;
    a[i * 4 + 3] = alpha;
  }

  const b = new Float32Array(count * 4);
  // Horizontal pass: a -> b.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let bl = 0;
      let al = 0;
      const from = Math.max(-radius, -x);
      const to = Math.min(radius, width - 1 - x);
      for (let d = from; d <= to; d++) {
        const w = kernel[d + radius];
        const o = (row + x + d) * 4;
        r += a[o] * w;
        g += a[o + 1] * w;
        bl += a[o + 2] * w;
        al += a[o + 3] * w;
      }
      const o = (row + x) * 4;
      b[o] = r;
      b[o + 1] = g;
      b[o + 2] = bl;
      b[o + 3] = al;
    }
  }

  const out = new Uint8ClampedArray(count * 4);
  // Vertical pass: b -> out, un-premultiplying as it goes.
  for (let y = 0; y < height; y++) {
    const from = Math.max(-radius, -y);
    const to = Math.min(radius, height - 1 - y);
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let bl = 0;
      let al = 0;
      for (let d = from; d <= to; d++) {
        const w = kernel[d + radius];
        const o = ((y + d) * width + x) * 4;
        r += b[o] * w;
        g += b[o + 1] * w;
        bl += b[o + 2] * w;
        al += b[o + 3] * w;
      }
      const o = (y * width + x) * 4;
      if (al > 0.5) {
        const inv = 255 / al;
        out[o] = r * inv;
        out[o + 1] = g * inv;
        out[o + 2] = bl * inv;
        out[o + 3] = al;
      }
    }
  }
  return out;
}

/**
 * The tile's square of a blurred, padded image, sampled onto `outSize` x
 * `outSize` texels laid out CORNER TO CORNER: the first and last texel of a row
 * hold the field exactly at the tile's border, not half a texel inside it.
 * MapLibre clamps a texture at its edge, so two neighbouring tiles then show the
 * same value on both sides of their border and no line appears (sampling
 * half a texel in leaves a step of one texel's gradient). The cost is a shift of
 * at most half a texel, a quarter of a source pixel for a 2x tile, about 1 km.
 *
 * `src` is `side` x `side` with the tile starting `margin` pixels in; pixel `j`
 * is centred at `j + 0.5`. Bilinear, the colour weighted by alpha so a clear
 * neighbour lowers the opacity without dragging the colour toward black.
 */
export function sampleTileEdgeToEdge(
  src: Uint8ClampedArray,
  side: number,
  margin: number,
  size: number,
  outSize: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(outSize * outSize * 4);
  const last = side - 1;
  const step = outSize > 1 ? size / (outSize - 1) : 0;
  for (let oy = 0; oy < outSize; oy++) {
    const fy = Math.min(last, Math.max(0, margin + oy * step - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(last, y0 + 1);
    const ty = fy - y0;
    for (let ox = 0; ox < outSize; ox++) {
      const fx = Math.min(last, Math.max(0, margin + ox * step - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(last, x0 + 1);
      const tx = fx - x0;
      const i00 = (y0 * side + x0) * 4;
      const i10 = (y0 * side + x1) * 4;
      const i01 = (y1 * side + x0) * 4;
      const i11 = (y1 * side + x1) * 4;
      const a00 = src[i00 + 3] * (1 - tx) * (1 - ty);
      const a10 = src[i10 + 3] * tx * (1 - ty);
      const a01 = src[i01 + 3] * (1 - tx) * ty;
      const a11 = src[i11 + 3] * tx * ty;
      const alpha = a00 + a10 + a01 + a11;
      const o = (oy * outSize + ox) * 4;
      if (alpha > 0) {
        for (let c = 0; c < 3; c++) {
          out[o + c] =
            (src[i00 + c] * a00 +
              src[i10 + c] * a10 +
              src[i01 + c] * a01 +
              src[i11 + c] * a11) /
            alpha;
        }
      }
      out[o + 3] = alpha;
    }
  }
  return out;
}

/** True when no pixel of the tile has any opacity (a dry tile). */
function isClear(tile: Uint8ClampedArray): boolean {
  for (let i = 3; i < tile.length; i += 4) if (tile[i] !== 0) return false;
  return true;
}

/**
 * Smooths the middle tile of a 3 x 3 block. `tiles` are the nine tiles' RGBA
 * pixels (`size` x `size` each), row by row from the north-west as
 * `neighbourTileUrls` lists them; a missing neighbour (null) counts as
 * transparent. Only the margin the blur reads is copied from the neighbours,
 * so the work is the tile plus a thin frame, not nine tiles.
 *
 * Returns the smoothed middle tile, or null when the middle tile is missing.
 * The result is `size * scale` pixels a side (`SMOOTH_UPSCALE` by default, see
 * there); `scale: 1` keeps the provider's size. A sigma under `MIN_SIGMA_PX`
 * returns the middle tile unchanged, at its own size. The blurred alpha is used
 * as it is: no gain, so the rain does not grow.
 */
export function smoothTile(
  tiles: readonly (Uint8ClampedArray | null)[],
  size: number,
  sigma: number,
  options: { scale?: number } = {},
): Uint8ClampedArray | null {
  const scale = Math.max(1, Math.floor(options.scale ?? SMOOTH_UPSCALE));
  const centre = tiles[4];
  if (!centre || centre.length !== size * size * 4) return null;
  if (!(sigma >= MIN_SIGMA_PX)) return centre;

  const margin = Math.min(size, blurMargin(sigma));
  const side = size + 2 * margin;
  // Dry weather is most of the map: a block with no rain anywhere in it is
  // clear without any work.
  if (tiles.every((t) => !t || t.length !== size * size * 4 || isClear(t))) {
    return new Uint8ClampedArray(size * scale * size * scale * 4);
  }
  const padded = new Uint8ClampedArray(side * side * 4);

  // Copy each of the nine tiles' overlap with the padded square.
  for (let ty = 0; ty < 3; ty++) {
    for (let tx = 0; tx < 3; tx++) {
      const tile = tiles[ty * 3 + tx];
      if (!tile || tile.length !== size * size * 4) continue;
      // The tile's top-left, in padded coordinates.
      const ox = margin + (tx - 1) * size;
      const oy = margin + (ty - 1) * size;
      const x0 = Math.max(0, ox);
      const x1 = Math.min(side, ox + size);
      const y0 = Math.max(0, oy);
      const y1 = Math.min(side, oy + size);
      if (x0 >= x1 || y0 >= y1) continue;
      for (let y = y0; y < y1; y++) {
        const from = ((y - oy) * size + (x0 - ox)) * 4;
        const len = (x1 - x0) * 4;
        padded.set(tile.subarray(from, from + len), (y * side + x0) * 4);
      }
    }
  }

  // The blur rounds the cells' hard edges. A tile kept at its own size is just
  // cropped; a finer one is sampled edge to edge (see sampleTileEdgeToEdge).
  const soft = blurRgba(padded, side, side, sigma);
  const outSize = size * scale;
  let out: Uint8ClampedArray;
  if (scale === 1) {
    out = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      const from = ((y + margin) * side + margin) * 4;
      out.set(soft.subarray(from, from + size * 4), y * size * 4);
    }
  } else {
    out = sampleTileEdgeToEdge(soft, side, margin, size, outSize);
  }
  return out;
}

/**
 * A small least-recently-used map. `get` counts as a use; `set` drops the
 * oldest entries past `limit`. `deleteIf` removes an entry only while it is
 * still the value the caller put there, so a slow failure cannot evict the
 * fresh entry that replaced it.
 */
export class LruCache<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly limit: number) {}

  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  deleteIf(key: string, value: T): void {
    if (this.entries.get(key) === value) this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
