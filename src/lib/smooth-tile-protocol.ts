/**
 * The browser half of tile smoothing (the maths is smooth-tile.ts).
 *
 * `registerSmoothProtocol` hooks MapLibre's `addProtocol` for `mksmooth://`
 * URLs. For one tile it fetches the tile and its eight neighbours straight
 * from the data provider (NASA GIBS: keyless, CORS-enabled, so no proxy and no
 * quota), decodes them, smooths the middle one with the margin read from the
 * neighbours (no seams) and hands MapLibre the decoded result as an
 * `ImageBitmap`, which it uploads without decoding again.
 *
 * Failure rules: the middle tile failing is the tile failing (the error goes
 * to MapLibre exactly as a plain tile's would, so "a failed overlay tile must
 * not stay blank" keeps working); a neighbour failing only means the frame of
 * margin on that side is transparent; and a browser that cannot decode or draw
 * (no canvas) gets the tile exactly as the provider sent it. A smoothed layer
 * therefore never shows less than an unsmoothed one.
 */

import {
  SMOOTH_TILE_SIZE,
  neighbourTileUrls,
  parseSmoothTileUrl,
  parseWmtsTile,
  smoothSigma,
  smoothTile,
  SMOOTH_PROTOCOL,
} from "./smooth-tile";

interface Decoded {
  size: number;
  data: Uint8ClampedArray;
}

/**
 * Decoded tiles kept for the next tile that shares them: every tile is read by
 * itself and by its eight neighbours, and a phone view holds a dozen tiles.
 * Small on purpose (a decoded 256 px tile is 256 KB).
 */
const DECODED_CACHE_LIMIT = 48;
const decodedCache = new Map<string, Promise<Decoded | null>>();

function context2d(
  size: number,
): (CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) | null {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(size, size).getContext("2d", {
      willReadFrequently: true,
    });
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    return canvas.getContext("2d", { willReadFrequently: true });
  }
  return null;
}

async function decode(bytes: ArrayBuffer): Promise<Decoded | null> {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  try {
    const size = bitmap.width;
    if (size !== bitmap.height || size < 2) return null;
    const ctx = context2d(size);
    if (!ctx) return null;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(bitmap, 0, 0);
    return { size, data: ctx.getImageData(0, 0, size, size).data };
  } finally {
    bitmap.close();
  }
}

/**
 * NASA GIBS is a free public service and now and then answers a tile that
 * exists with a 404 (measured 2026-11-11: one URL gave 200, 404, 200 in a
 * row). An unsmoothed layer shows that as a hole in the picture; a smoothed one
 * would also show a seam where a neighbour's margin went missing. So a failed
 * tile is asked for again, twice, after a short wait.
 */
export const TILE_RETRY_DELAYS_MS = [200, 500] as const;

export interface FetchDeps {
  fetchFn?: (
    url: string,
    init?: { signal?: AbortSignal },
  ) => Promise<{
    ok: boolean;
    arrayBuffer: () => Promise<ArrayBuffer>;
  }>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * The tile's bytes, or null once it has failed `TILE_RETRY_DELAYS_MS.length + 1`
 * times (a non-OK status or a network error). An abort stops at once.
 */
export async function fetchBytes(
  url: string,
  signal?: AbortSignal,
  deps: FetchDeps = {},
): Promise<ArrayBuffer | null> {
  const doFetch = deps.fetchFn ?? ((u, init) => fetch(u, init));
  const wait = deps.sleep ?? sleepMs;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await doFetch(url, { signal });
      if (res.ok) return await res.arrayBuffer();
    } catch {
      // A network error is retried like a bad status.
    }
    if (signal?.aborted) return null;
    const delay = TILE_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return null;
    await wait(delay, signal);
    if (signal?.aborted) return null;
  }
}

/** Keeps a decoded tile for the next one that shares it, dropping the oldest past the limit. */
function remember(url: string, tile: Promise<Decoded | null>): void {
  decodedCache.set(url, tile);
  // A failure must not poison the next request for the same tile.
  void tile.then((t) => {
    if (!t) decodedCache.delete(url);
  });
  if (decodedCache.size > DECODED_CACHE_LIMIT) {
    const oldest = decodedCache.keys().next().value;
    if (oldest !== undefined) decodedCache.delete(oldest);
  }
}

/**
 * One decoded neighbour, shared by every tile that needs it. Fetched without
 * the requesting tile's abort signal: it is small, the browser caches it, and
 * another tile may be waiting on the same promise.
 */
function decodedTile(url: string): Promise<Decoded | null> {
  const known = decodedCache.get(url);
  if (known) return known;
  const pending = fetchBytes(url)
    .then((bytes) => (bytes ? decode(bytes) : null))
    .catch(() => null);
  remember(url, pending);
  return pending;
}

/**
 * Loads one smoothed tile. Rejects when the tile itself cannot be loaded;
 * resolves to the provider's own bytes when smoothing is not possible here.
 */
export async function loadSmoothTile(
  smoothUrl: string,
  signal: AbortSignal,
): Promise<{ data: ImageBitmap | ArrayBuffer }> {
  const parsed = parseSmoothTileUrl(smoothUrl);
  const wmts = parsed && parseWmtsTile(parsed.url);
  if (!parsed || !wmts) throw new Error("not a smoothed tile address");

  // The tile itself, as the provider sent it: what to show if smoothing cannot run.
  const original = await fetchBytes(parsed.url, signal);
  if (!original) throw new Error(`tile HTTP error ${parsed.url}`);

  try {
    const urls = neighbourTileUrls(parsed.url);
    if (!urls) return { data: original };
    const centre = await decode(original);
    if (!centre || centre.size !== SMOOTH_TILE_SIZE) return { data: original };
    remember(parsed.url, Promise.resolve(centre));

    const around = await Promise.all(
      urls.map((u, i) =>
        i === 4 ? Promise.resolve(centre) : u ? decodedTile(u) : null,
      ),
    );
    const tiles = around.map((t) =>
      t && t.size === centre.size ? t.data : null,
    );
    const smoothed = smoothTile(
      tiles,
      centre.size,
      smoothSigma(parsed.cellDegrees, wmts.z, centre.size),
    );
    if (!smoothed) return { data: original };
    // The result is `scale` times finer (SMOOTH_UPSCALE); its side comes from its length.
    const side = Math.round(Math.sqrt(smoothed.length / 4));
    const pixels = new ImageData(new Uint8ClampedArray(smoothed), side, side);
    return { data: await createImageBitmap(pixels) };
  } catch {
    if (signal.aborted) throw new Error("aborted");
    return { data: original };
  }
}

let registered = false;

/** Hooks `mksmooth://` into MapLibre once per page. `addProtocol` is MapLibre's. */
export function registerSmoothProtocol(
  addProtocol: (
    protocol: string,
    load: (
      params: { url: string },
      abortController: AbortController,
    ) => Promise<{ data: ImageBitmap | ArrayBuffer }>,
  ) => void,
): void {
  if (registered) return;
  registered = true;
  addProtocol(SMOOTH_PROTOCOL, (params, abortController) =>
    loadSmoothTile(params.url, abortController.signal),
  );
}
