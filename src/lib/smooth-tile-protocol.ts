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
 * Load on NASA GIBS. A smoothed layer asks for the tiles in view PLUS the ring
 * around them, each tile once: a phone at map zoom 7 shows about 6 tiles and
 * asks for about 20 (a plain layer asks for 6). The tiles are 1 to 3 KB, GIBS
 * sends them `no-store` so the browser keeps none, and the 400 tiles kept here
 * (a few hundred KB, as encoded bytes) cover both frames of the timeline the
 * map holds at once plus panning, so a neighbour is fetched once per frame, not
 * once per tile that needs it.
 *
 * Failure rules: the middle tile failing is the tile failing (the error goes
 * to MapLibre exactly as a plain tile's would, so "a failed overlay tile must
 * not stay blank" keeps working); a neighbour failing only means the frame of
 * margin on that side is transparent; and a browser that cannot decode or draw
 * (no canvas) gets the tile exactly as the provider sent it. A smoothed layer
 * therefore never shows less than an unsmoothed one. An aborted request rejects
 * with an `AbortError`, as MapLibre expects.
 */

import {
  LruCache,
  SMOOTH_PROTOCOL,
  SMOOTH_TILE_SIZE,
  neighbourTileUrls,
  parseSmoothTileUrl,
  parseWmtsTile,
  smoothSigma,
  smoothTile,
} from "./smooth-tile";

export interface Decoded {
  size: number;
  data: Uint8ClampedArray;
}

/**
 * Tiles kept as the provider's encoded bytes. 400 covers the two frames the
 * map holds (current and preload) for a large screen, and a tile is 1 to 3 KB.
 */
export const BYTES_CACHE_LIMIT = 400;
/** Decoded tiles kept for the burst of neighbours that share them (256 KB each). */
export const DECODED_CACHE_LIMIT = 24;

/**
 * Waits before asking again for the tile the picture is built on. GIBS is a
 * free public service and now and then answers a tile that exists with a 404
 * (measured 2026-11-11: one URL gave 200, 404, 200 in a row), so a 404 is
 * asked for once more; a 5xx, 429 or a network error up to twice. Any other
 * 4xx is final. Neighbours are asked for once: a missing one only thins the
 * margin, and an edge tile that really has no neighbour must not be held up.
 */
export const TILE_RETRY_DELAYS_MS = [200, 500] as const;

export interface FetchResponse {
  ok: boolean;
  status: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

/** Everything that touches the browser, so the loader can be tested without one. */
export interface LoaderDeps {
  fetchFn?: (
    url: string,
    init?: { signal?: AbortSignal },
  ) => Promise<FetchResponse>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  decode?: (bytes: ArrayBuffer) => Promise<Decoded | null>;
  toBitmap?: (pixels: Uint8ClampedArray, side: number) => Promise<ImageBitmap>;
  bytes?: LruCache<Promise<ArrayBuffer | null>>;
  decoded?: LruCache<Promise<Decoded | null>>;
}

const sharedBytes = new LruCache<Promise<ArrayBuffer | null>>(
  BYTES_CACHE_LIMIT,
);
const sharedDecoded = new LruCache<Promise<Decoded | null>>(
  DECODED_CACHE_LIMIT,
);

/** What MapLibre expects to catch when it aborts a tile request. */
export function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/** Resolves after `ms`, or at once if the signal is (or becomes) aborted. */
export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * The tile's bytes, or null when it cannot be had. With `retry` (the middle
 * tile only) a 404 is asked for once more and a 5xx, 429 or network error up
 * to `TILE_RETRY_DELAYS_MS.length` times; without it, once. An abort throws an
 * `AbortError` at once.
 */
export async function fetchBytes(
  url: string,
  signal?: AbortSignal,
  deps: LoaderDeps = {},
  retry = false,
): Promise<ArrayBuffer | null> {
  const doFetch = deps.fetchFn ?? ((u, init) => fetch(u, init));
  const wait = deps.sleep ?? sleepMs;
  let retried404 = false;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError();
    let status = 0;
    try {
      const res = await doFetch(url, { signal });
      if (res.ok) return await res.arrayBuffer();
      status = res.status;
    } catch {
      // A network error is retried like a 5xx; an abort is not.
    }
    if (signal?.aborted) throw abortError();
    if (!retry) return null;
    const delay = TILE_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return null;
    if (status === 404) {
      if (retried404) return null;
      retried404 = true;
    } else if (status >= 400 && status < 500 && status !== 429) {
      return null; // any other 4xx is final
    }
    await wait(delay, signal);
  }
}

function context2d(
  size: number,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
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

/** Decodes tile bytes to pixels, or null when the browser cannot draw them. */
export async function decodeTile(bytes: ArrayBuffer): Promise<Decoded | null> {
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

function pixelsToBitmap(
  pixels: Uint8ClampedArray,
  side: number,
): Promise<ImageBitmap> {
  return createImageBitmap(
    new ImageData(new Uint8ClampedArray(pixels), side, side),
  );
}

/** A neighbour's bytes, shared by every tile that needs it and kept for the next. */
function neighbourBytes(
  url: string,
  deps: LoaderDeps,
): Promise<ArrayBuffer | null> {
  const cache = deps.bytes ?? sharedBytes;
  const known = cache.get(url);
  if (known) return known;
  // No abort signal: another tile may be waiting on the same promise.
  const pending = fetchBytes(url, undefined, deps).catch(() => null);
  cache.set(url, pending);
  // A failure must not poison the next request, but only drop OUR entry.
  void pending.then((b) => {
    if (!b) cache.deleteIf(url, pending);
  });
  return pending;
}

/** The middle tile's bytes: from the cache if a neighbour already fetched it. */
async function centreBytes(
  url: string,
  signal: AbortSignal,
  deps: LoaderDeps,
): Promise<ArrayBuffer> {
  const cache = deps.bytes ?? sharedBytes;
  const known = await cache.get(url);
  if (known) return known;
  const bytes = await fetchBytes(url, signal, deps, true);
  if (!bytes) throw new Error(`tile HTTP error ${url}`);
  cache.set(url, Promise.resolve(bytes));
  return bytes;
}

function decodedTile(
  url: string,
  bytes: ArrayBuffer,
  deps: LoaderDeps,
): Promise<Decoded | null> {
  const cache = deps.decoded ?? sharedDecoded;
  const known = cache.get(url);
  if (known) return known;
  const pending = (deps.decode ?? decodeTile)(bytes).catch(() => null);
  cache.set(url, pending);
  void pending.then((d) => {
    if (!d) cache.deleteIf(url, pending);
  });
  return pending;
}

/**
 * Loads one smoothed tile. Rejects when the tile itself cannot be loaded (an
 * `AbortError` when the request was aborted); resolves to the provider's own
 * bytes when smoothing is not possible here.
 */
export async function loadSmoothTile(
  smoothUrl: string,
  signal: AbortSignal,
  deps: LoaderDeps = {},
): Promise<{ data: ImageBitmap | ArrayBuffer }> {
  const parsed = parseSmoothTileUrl(smoothUrl);
  const wmts = parsed && parseWmtsTile(parsed.url);
  if (!parsed || !wmts) throw new Error("not a smoothed tile address");

  // The tile itself, as the provider sent it: what to show if smoothing cannot run.
  const original = await centreBytes(parsed.url, signal, deps);

  try {
    const urls = neighbourTileUrls(parsed.url);
    if (!urls) return { data: original };
    const centre = await decodedTile(parsed.url, original, deps);
    if (!centre || centre.size !== SMOOTH_TILE_SIZE) return { data: original };

    const around = await Promise.all(
      urls.map(async (u, i) => {
        if (i === 4) return centre;
        if (!u) return null;
        const bytes = await neighbourBytes(u, deps);
        return bytes ? decodedTile(u, bytes, deps) : null;
      }),
    );
    if (signal.aborted) throw abortError();
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
    const bitmap = await (deps.toBitmap ?? pixelsToBitmap)(smoothed, side);
    if (signal.aborted) {
      bitmap.close?.();
      throw abortError();
    }
    return { data: bitmap };
  } catch {
    if (signal.aborted) throw abortError();
    return { data: original };
  }
}

const registeredWith = new WeakSet<object>();

/** Hooks `mksmooth://` into MapLibre once per page. `addProtocol` is MapLibre's. */
export function registerSmoothProtocol(
  addProtocol: (
    protocol: string,
    load: (
      params: { url: string },
      abortController: AbortController,
    ) => Promise<{ data: ImageBitmap | ArrayBuffer }>,
  ) => void,
  deps: LoaderDeps = {},
): void {
  if (registeredWith.has(addProtocol)) return;
  registeredWith.add(addProtocol);
  addProtocol(SMOOTH_PROTOCOL, (params, abortController) =>
    loadSmoothTile(params.url, abortController.signal, deps),
  );
}
