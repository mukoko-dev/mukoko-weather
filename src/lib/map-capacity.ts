/**
 * Is live weather-overlay data available right now? (#542)
 *
 * Rain, Temperature, Wind and Cloud are Tomorrow.io tiles served by the tiles
 * Worker. The owner has no paid Tomorrow.io plan (25 calls an hour, 500 a day,
 * shared with the forecasts), so when the quota is spent the Worker answers
 * every tile with its blank placeholder: a 1x1 transparent PNG with the header
 * `X-Map-Tile: empty` (workers/tiles/src/lib.rs, `empty_response`). The map
 * would draw nothing and say nothing.
 *
 * This module decides, before the map asks for dozens of tiles, whether those
 * layers will draw: it asks the Worker for ONE tile and reads the answer. There
 * is one key and one quota behind all four layers, so there is ONE verdict for
 * all of them (not one per layer): switching between the four chips never asks
 * again while the verdict is kept (a minute). The map then falls back to the
 * default layer and says so (LayerCapacityNote).
 *
 * Nothing here asks again by itself. The verdict is only looked at again when
 * the person changes layer or place or reloads (and then only if it is older
 * than a minute), or taps "Try again" (one real request, never more often than
 * every 10 s). A tab left open on the fallback stays there until one of those:
 * re-asking on a timer would spend quota in every open tab.
 *
 * KNOWN LIMIT (not fixed here, needs a Worker-side signal or a provider with
 * capacity): the Worker serves its edge-cache and KV hits, STALE ones too, as
 * real PNGs with no `X-Map-Tile` header, before it looks at its breaker or the
 * quota. The tile under the place is the one other visitors most likely cached,
 * so with the quota spent and that tile cached the probe says `live` while the
 * neighbouring tiles come back blank. The check catches a fully blank layer, not
 * a partly blank one. On an origin the Worker's CORS list does not allow (a
 * preview deploy) the browser hides the answer: the verdict is `unknown`, the
 * map behaves as it did before and the note cannot be seen.
 *
 * Pure functions, a small store and one factory; the network call is injected so
 * every rule is unit-tested without a browser.
 */

import {
  DEFAULT_LAYER,
  MAP_LAYERS,
  getMapChip,
  WEATHER_OVERLAY_MAX_ZOOM,
  WEATHER_OVERLAY_MIN_ZOOM,
  weatherOverlayTileUrl,
} from "./map-layers";
import { STATIC_TILE_SIZE, worldPixel } from "./static-map";

/**
 * - `live`: a real tile came back, the layer will draw.
 * - `busy`: the Worker sent its blank placeholder, or said it is over its
 *   limit or down (429, 5xx). The layer would draw nothing.
 * - `unknown`: the answer could not be read (offline, timeout, a response the
 *   browser hides, an unexpected 4xx). Treated like `live`: the map tries the
 *   layer as it always did and its own error notice covers a real failure.
 */
export type CapacityVerdict = "live" | "busy" | "unknown";

/** How long a verdict (of any kind) is trusted before the layer is asked again. */
export const CAPACITY_VERDICT_TTL_MS = 60_000;

/**
 * The shortest wait between two real requests for one layer, even when the
 * person taps "Try again": a button must not be a way to hammer a quota.
 */
export const CAPACITY_RECHECK_FLOOR_MS = 10_000;

/** A tile that has not answered in this long is `unknown`, and the map goes on. */
export const CAPACITY_PROBE_TIMEOUT_MS = 4_000;

/** The header the tiles Worker puts on its placeholder (exposed through CORS). */
const PLACEHOLDER_HEADER = "X-Map-Tile";

/** Whether `layerId` is a Tomorrow.io overlay (the ones the tiles Worker serves). */
export function isTomorrowLayer(layerId: string | null | undefined): boolean {
  return !!layerId && MAP_LAYERS.some((l) => l.id === layerId);
}

/** What the probe knows right now (the part the map reads). */
export interface CapacityView {
  /** The last verdict, whatever its age; null before the first answer. */
  verdict: CapacityVerdict | null;
  /** A tile request is out (a first ask, an expired verdict, or "Try again"). */
  inFlight: boolean;
}

export interface CapacityState {
  /** The layer to draw: the one asked for, or `fallback` while it is busy. */
  layer: string;
  /** The asked-for layer is a Tomorrow.io one and the Worker has no live tile. */
  busy: boolean;
  /**
   * The asked-for layer is a Tomorrow.io one and there is no usable verdict
   * (none yet, or a stale one being asked again): hold its overlay back, so a
   * dozen tiles are not asked for before one has said whether they will draw.
   */
  held: boolean;
  /** A request is out for the answer (`held` or `busy`): say so. */
  checking: boolean;
}

/**
 * What the map shows for the layer the person asked for, given what the probe
 * knows. Only Tomorrow.io layers are ever held or swapped; the default layer,
 * air quality, wildfire and the model fields never are. Pure: the person's
 * choice is not touched, so the layer is drawn again once a verdict says `live`.
 *
 * A `busy` verdict keeps the fallback on screen while it is asked again (a
 * "Try again"), so the map does not flicker back to a blank layer.
 */
export function capacityState(
  requested: string,
  view: CapacityView,
  fallback: string = DEFAULT_LAYER,
): CapacityState {
  if (!isTomorrowLayer(requested))
    return { layer: requested, busy: false, held: false, checking: false };
  if (view.verdict === "busy")
    return {
      layer: fallback,
      busy: true,
      held: false,
      checking: view.inFlight,
    };
  if (view.verdict === null || view.inFlight)
    return {
      layer: requested,
      busy: false,
      held: true,
      checking: view.inFlight,
    };
  return { layer: requested, busy: false, held: false, checking: false };
}

/**
 * What the person is told a busy layer is called, in the same words the chips
 * use. Keyed by layer id; anything else reads as "Live weather".
 */
const BUSY_SUBJECTS: Readonly<Record<string, string>> = {
  precipitationIntensity: "Live rain radar",
  temperature: "Live temperature map",
  windSpeed: "Live wind map",
  cloudCover: "Live cloud map",
  humidity: "Live humidity map",
};

/** "Live rain radar" for a layer id, for the note and the retry button's name. */
export function busySubject(layerId: string): string {
  return BUSY_SUBJECTS[layerId] ?? "Live weather";
}

/** The chip name of the layer shown instead ("Satellite"). */
export function fallbackLayerLabel(): string {
  return getMapChip(DEFAULT_LAYER)?.label ?? "the default layer";
}

/**
 * The note shown when a layer is replaced: plain, no blame, no jargon.
 * `fallbackLabel` is the chip name of the layer shown instead ("Satellite").
 */
export function capacityNoteText(
  layerId: string,
  fallbackLabel: string,
): string {
  return `${busySubject(layerId)} is busy right now. Showing ${fallbackLabel.toLowerCase()} instead.`;
}

/** A Web Mercator tile index. */
export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

/**
 * The overlay tile the map asks for first when it opens on a place: the tile
 * under the place, at the zoom MapLibre requests for a 512 px raster source
 * (the map's own zoom, capped to the overlay's range). It is the same URL the
 * map is about to request, so the browser's cache gives the map this very tile
 * and the probe adds no request to a healthy view.
 */
export function probeTileFor(
  lat: number,
  lon: number,
  mapZoom: number,
): TileCoord {
  const z = Math.max(
    WEATHER_OVERLAY_MIN_ZOOM,
    Math.min(WEATHER_OVERLAY_MAX_ZOOM, Math.floor(mapZoom)),
  );
  const last = 2 ** z - 1;
  const { x, y } = worldPixel(lat, lon, z);
  return {
    z,
    x: Math.max(0, Math.min(last, Math.floor(x / STATIC_TILE_SIZE))),
    y: Math.max(0, Math.min(last, Math.floor(y / STATIC_TILE_SIZE))),
  };
}

/** The probe's request URL: the layer's "now" tile for `tile`. */
export function probeTileUrl(layerId: string, tile: TileCoord): string {
  return weatherOverlayTileUrl(layerId)
    .replace("{z}", String(tile.z))
    .replace("{x}", String(tile.x))
    .replace("{y}", String(tile.y));
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Whether `bytes` is a PNG that is 1x1 pixel: the Worker's placeholder (68
 * bytes). A real tile is 256 px or more, so a 1x1 picture is never data. This
 * is the fallback for a response whose `X-Map-Tile` header was stripped on the
 * way (a proxy, a cache layer); the header is the cheap, first check.
 */
export function isPlaceholderPng(bytes: Uint8Array): boolean {
  if (bytes.length < 24) return false;
  if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return false;
  // The IHDR chunk follows the signature: length (4), "IHDR" (4), then the
  // width and height as big-endian 32-bit integers.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(16) === 1 && view.getUint32(20) === 1;
}

/** The part of a `Response` the verdict reads (so tests need no real Response). */
export interface ProbeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Reads one tile answer. Order, cheapest first: a limit or outage status, the
 * placeholder header, then (only when the header says nothing) the picture.
 */
export async function verdictFromResponse(
  res: ProbeResponse,
): Promise<CapacityVerdict> {
  if (res.status === 429 || res.status >= 500) return "busy";
  if (!res.ok) return "unknown";
  if (res.headers.get(PLACEHOLDER_HEADER)?.toLowerCase() === "empty")
    return "busy";
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) return "unknown";
  return isPlaceholderPng(bytes) ? "busy" : "live";
}

export interface CapacityCheck {
  /** The layer asked for: its tile is the probe (the verdict covers all four). */
  layer: string;
  lat: number;
  lon: number;
  /** The map's zoom when it opens (the probe tile is the one under the place). */
  mapZoom: number;
}

/** What a "Try again" learned. */
export interface RecheckResult {
  verdict: CapacityVerdict;
  /** This call sent the request. False: answered from memory or by one already out. */
  asked: boolean;
  /** Milliseconds until a real request is allowed again (0: now). */
  retryAfterMs: number;
}

export interface CapacityProbeDeps {
  fetch?: (
    url: string,
    init?: { signal?: AbortSignal; cache?: RequestCache },
  ) => Promise<ProbeResponse>;
  now?: () => number;
  ttlMs?: number;
  recheckFloorMs?: number;
  timeoutMs?: number;
}

export interface CapacityProbe {
  /** For `useSyncExternalStore`: called after every change of the view. */
  subscribe: (listener: () => void) => () => void;
  /** The view; the same object until something changes. */
  getSnapshot: () => CapacityView;
  /** The view on the server and during hydration: nothing known, nothing out. */
  getServerSnapshot: () => CapacityView;
  /**
   * Looks at the verdict for the Tomorrow.io layers: kept while younger than
   * the TTL (no request), shared with a request already out, else one tile
   * request. A layer that is not a Tomorrow.io one is never asked about.
   * Never rejects.
   */
  check: (request: CapacityCheck) => Promise<CapacityVerdict>;
  /**
   * "Try again": skips the TTL (and the browser's copy of the placeholder), but
   * never the floor: inside it the answer comes from memory and `asked` is
   * false, so the button can say it just looked. Never rejects.
   */
  recheck: (request: CapacityCheck) => Promise<RecheckResult>;
}

const NOTHING_KNOWN: CapacityView = { verdict: null, inFlight: false };

/**
 * A probe with its own memory. The app uses one for the whole session
 * (`layerCapacity` below); tests make their own with a fake `fetch` and clock.
 *
 * Rules: there is ONE verdict, shared by all four Tomorrow.io layers; a verdict
 * of any kind is kept for `ttlMs`; a request already out is shared, never
 * doubled; there is no retry and no timer, so a failed request is a verdict
 * (`unknown`) kept like any other and nothing asks again unless called.
 */
export function createCapacityProbe(
  deps: CapacityProbeDeps = {},
): CapacityProbe {
  const doFetch =
    deps.fetch ??
    ((url: string, init?: { signal?: AbortSignal; cache?: RequestCache }) =>
      globalThis.fetch(url, init));
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? CAPACITY_VERDICT_TTL_MS;
  const floorMs = deps.recheckFloorMs ?? CAPACITY_RECHECK_FLOOR_MS;
  const timeoutMs = deps.timeoutMs ?? CAPACITY_PROBE_TIMEOUT_MS;

  let view: CapacityView = NOTHING_KNOWN;
  let answeredAt = 0;
  let pending: Promise<CapacityVerdict> | null = null;
  const listeners = new Set<() => void>();

  function publish(next: CapacityView) {
    view = next;
    for (const listener of listeners) listener();
  }

  /** One tile request; resolves to a verdict, never rejects, gives up at the timeout. */
  async function ask(
    request: CapacityCheck,
    bypassCache: boolean,
  ): Promise<CapacityVerdict> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<CapacityVerdict>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("unknown");
      }, timeoutMs);
    });
    const tile = probeTileFor(request.lat, request.lon, request.mapZoom);
    const answer: Promise<CapacityVerdict> = (async () => {
      const res = await doFetch(probeTileUrl(request.layer, tile), {
        signal: controller.signal,
        // The placeholder is kept by the browser for 30 s (its Cache-Control),
        // so a "Try again" must not be answered from that copy.
        cache: bypassCache ? "no-cache" : "default",
      });
      return verdictFromResponse(res);
    })().catch(() => "unknown" as const);
    try {
      // A request that ignores the abort cannot hold the map: the timeout wins
      // and a late answer is dropped.
      return await Promise.race([answer, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  function run(
    request: CapacityCheck,
    maxAgeMs: number,
    bypassCache: boolean,
  ): Promise<RecheckResult> {
    if (!isTomorrowLayer(request.layer))
      return Promise.resolve({
        verdict: "unknown",
        asked: false,
        retryAfterMs: 0,
      });
    const age = now() - answeredAt;
    const remaining = () => Math.max(0, floorMs - (now() - answeredAt));
    if (view.verdict !== null && age < maxAgeMs)
      return Promise.resolve({
        verdict: view.verdict,
        asked: false,
        retryAfterMs: remaining(),
      });
    if (pending)
      return pending.then((verdict) => ({
        verdict,
        asked: false,
        retryAfterMs: remaining(),
      }));
    publish({ verdict: view.verdict, inFlight: true });
    const started = ask(request, bypassCache).then((verdict) => {
      pending = null;
      answeredAt = now();
      publish({ verdict, inFlight: false });
      return verdict;
    });
    pending = started;
    return started.then((verdict) => ({
      verdict,
      asked: true,
      retryAfterMs: floorMs,
    }));
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => view,
    getServerSnapshot: () => NOTHING_KNOWN,
    check: (request) => run(request, ttlMs, false).then((r) => r.verdict),
    recheck: (request) => run(request, floorMs, true),
  };
}

/** The session's probe: one memory shared by every map on the page. */
export const layerCapacity: CapacityProbe = createCapacityProbe();
