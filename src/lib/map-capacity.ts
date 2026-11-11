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
 * This module decides, before the map asks for dozens of tiles, whether the
 * layer will draw: it asks the Worker for ONE tile of the layer, at most once
 * a minute per layer, and reads the answer. The map then falls back to the
 * default layer and says so (LayerCapacityNote). Nothing here is permanent: the
 * verdict expires, so the layers return on their own when the provider does.
 *
 * Pure functions and one small factory; the network call is injected so every
 * rule is unit-tested without a browser.
 */

import {
  DEFAULT_LAYER,
  MAP_LAYERS,
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

export interface CapacityState {
  /** The layer to draw: the one asked for, or `fallback` while it is busy. */
  layer: string;
  /** The asked-for layer is a Tomorrow.io one with no live tile. */
  busy: boolean;
  /**
   * The asked-for layer is a Tomorrow.io one with no answer yet: hold its
   * overlay back until one tile has said whether the rest will draw.
   */
  held: boolean;
}

/**
 * What the map shows for the layer the person asked for, given the verdict so
 * far (null: no answer yet). Only Tomorrow.io layers are ever held or swapped;
 * the default layer, air quality, wildfire and the model fields never are. Pure:
 * the person's choice is not touched, so it is drawn again once the verdict is
 * `live`.
 */
export function capacityState(
  requested: string,
  verdict: CapacityVerdict | null,
  fallback: string = DEFAULT_LAYER,
): CapacityState {
  if (!isTomorrowLayer(requested))
    return { layer: requested, busy: false, held: false };
  if (verdict === null) return { layer: requested, busy: false, held: true };
  const busy = verdict === "busy";
  return { layer: busy ? fallback : requested, busy, held: false };
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
  layer: string;
  lat: number;
  lon: number;
  /** The map's zoom when it opens (the probe tile is the one under the place). */
  mapZoom: number;
  /**
   * The person asked again ("Try again"): skip the 60 s memory, but not the
   * short floor between real requests.
   */
  force?: boolean;
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
  /**
   * The verdict for a layer: remembered when fresh, shared with a probe already
   * in flight, otherwise one tile request. Never rejects.
   */
  check(request: CapacityCheck): Promise<CapacityVerdict>;
}

/**
 * A probe with its own memory. The app uses one for the whole session
 * (`layerCapacity` below); tests make their own with a fake `fetch` and clock.
 *
 * Rules, all per layer: a verdict of any kind is kept for `ttlMs`; a request
 * already in flight is shared, never doubled; `force` shortens the memory to
 * `recheckFloorMs`; there is no retry, so a failed request is a verdict
 * (`unknown`) kept like any other.
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

  const verdicts = new Map<string, { verdict: CapacityVerdict; at: number }>();
  const inFlight = new Map<string, Promise<CapacityVerdict>>();

  function fresh(layer: string, maxAgeMs: number): CapacityVerdict | null {
    const kept = verdicts.get(layer);
    return kept && now() - kept.at < maxAgeMs ? kept.verdict : null;
  }

  async function ask(request: CapacityCheck): Promise<CapacityVerdict> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const tile = probeTileFor(request.lat, request.lon, request.mapZoom);
      const res = await doFetch(probeTileUrl(request.layer, tile), {
        signal: controller.signal,
        // The placeholder is kept by the browser for 30 s (its Cache-Control),
        // so a "Try again" must not be answered from that copy.
        cache: request.force ? "no-cache" : "default",
      });
      return await verdictFromResponse(res);
    } catch {
      return "unknown";
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    check(request) {
      const kept = fresh(request.layer, request.force ? floorMs : ttlMs);
      if (kept) return Promise.resolve(kept);
      const pending = inFlight.get(request.layer);
      if (pending) return pending;
      const started = ask(request).then((verdict) => {
        verdicts.set(request.layer, { verdict, at: now() });
        inFlight.delete(request.layer);
        return verdict;
      });
      inFlight.set(request.layer, started);
      return started;
    },
  };
}

/** The session's probe: one memory shared by every map on the page. */
export const layerCapacity: CapacityProbe = createCapacityProbe();
