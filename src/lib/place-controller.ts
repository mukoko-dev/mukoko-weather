/**
 * The place stage: which place is on screen, and how its weather arrives.
 *
 * The page the server sends carries NO weather. It holds the place (name,
 * coordinates, season, country) and the app shell; the weather is painted
 * from the device first and fetched by the visitor's own browser (own IP,
 * own rate budget) — see `getWeatherForLocation`'s history in issue #414.
 * The same controller turns a switch between places (pager, swipe, saved
 * list, search) into a state change plus `history.pushState`, so the app
 * stays mounted and only that place's data is fetched.
 *
 * Pure of React, the DOM and the network: everything it touches is injected
 * (`PlaceDeps`), so the sequencing is tested without a browser.
 *
 * Rules:
 * - A place is shown atomically: the previous place stays on screen until the
 *   next place's first view (memory, then device) is known, then the URL, the
 *   place and its view change together. Content is never shown under the
 *   wrong place's name.
 * - A stored view up to REFRESH_AFTER_MS old is shown as it is and costs no
 *   request; an older one is shown at once and refreshed in the background.
 * - Only the latest request may set the screen (`createLatestRequests`), but
 *   a fetch that finished for a place the visitor already left is still kept
 *   in memory, so swiping back needs no request.
 * - A Worker answer that is the seasonal estimate never replaces real data
 *   already on screen.
 */

import type { WeatherLocation } from "./locations";
import type { Season, WeatherData } from "./weather";
import { checkFrostRisk } from "./weather";
import {
  REFRESH_AFTER_MS,
  deviceViewOf,
  slimPayload,
  type DashboardPayload,
  type DeviceView,
  type Freshness,
} from "./device-weather";
import { createLatestRequests, type LatestRequest } from "./latest-request";
import { countryDisplayName, reconcileCountry } from "./location-country";
import { reconcileElevation } from "./location-elevation";
import { pathOfTarget, placeTargetOf, type PlaceTarget } from "./place-target";

/** The place without its weather: everything the server can know. */
export interface PlaceSeed {
  location: WeatherLocation;
  season: Season;
  countryName: string;
}

export interface PlaceState {
  /** The place on screen (null until a place is known). */
  seed: PlaceSeed | null;
  /** What to render: stored or live weather for `seed`; null shows the skeleton. */
  view: DashboardPayload | null;
  /** Set while `view` came from memory or the device rather than the network. */
  device: { fetchedAt: number; freshness: Freshness } | null;
  /** A network fetch for `seed` is in flight. */
  fetching: boolean;
  /** The last fetch for `seed` failed and nothing newer replaced it. */
  failed: boolean;
  /** `seed` is the place `/` shows (My Location). */
  isHome: boolean;
  /** The pathname this state belongs to: "/" or "/{slug}". */
  path: string;
}

export type UrlAction = "push" | "replace" | "none";

export interface PlaceDeps {
  now(): number;
  /** The stored copy of a place (memory misses fall through to the device). */
  recall(slug: string): Promise<DeviceView | null>;
  /** Live weather from the Worker (the visitor's own request). */
  fetchWeather(
    lat: number,
    lon: number,
    signal: AbortSignal,
  ): Promise<{ weather: WeatherData; usingFallback: boolean }>;
  /** A place for a slug the stage has not seen (catalogue, Worker, spot). */
  resolve(slug: string, signal: AbortSignal): Promise<PlaceSeed | null>;
  history: {
    path(): string;
    push(path: string): void;
    replace(path: string): void;
  };
  /** Called whenever the place on screen changes. */
  onShow?(event: { seed: PlaceSeed; isHome: boolean; url: UrlAction }): void;
  /** Longest to wait for the device before fetching without it. */
  recallTimeoutMs?: number;
}

// ── In-memory copies ────────────────────────────────────────────────────────

/** Places kept in memory for the life of the page (most recent last). */
export const MEMORY_MAX_PLACES = 12;

interface MemoryEntry {
  payload: DashboardPayload;
  fetchedAt: number;
}

const memory = new Map<string, MemoryEntry>();

/** Remember a real forecast for a place. The seasonal estimate is never kept. */
export function rememberInMemory(
  payload: DashboardPayload,
  fetchedAt: number,
): void {
  if (payload.usingFallback) return;
  const slug = payload.location.slug;
  memory.delete(slug);
  memory.set(slug, { payload: slimPayload(payload), fetchedAt });
  while (memory.size > MEMORY_MAX_PLACES) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

/** The in-memory copy of a place, re-based on `now`, or null. */
export function recallFromMemory(slug: string, now: number): DeviceView | null {
  const entry = memory.get(slug);
  if (!entry) return null;
  const view = deviceViewOf(entry, now);
  if (!view) memory.delete(slug);
  return view;
}

/** Tests only. */
export function clearPlaceMemory(): void {
  memory.clear();
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/** True when a stored view needs no request: current and young enough. */
export function isFreshEnough(view: DeviceView, now: number): boolean {
  return (
    view.freshness === "current" && now - view.fetchedAt <= REFRESH_AFTER_MS
  );
}

/** The seed of a stored payload (its place, season and country). */
export function seedOfPayload(payload: DashboardPayload): PlaceSeed {
  return {
    location: payload.location,
    season: payload.season,
    countryName: payload.countryName,
  };
}

/**
 * A stored payload shown under the server's seed for the same place: the
 * server's season is the freshest, and its location is authoritative unless
 * the stored one was reconciled against a forecast (country from the time
 * zone) that the seed could not be.
 */
export function mergeStoredWithSeed(
  payload: DashboardPayload,
  seed: PlaceSeed,
): DashboardPayload {
  const storedKnowsCountry =
    !!payload.location.country && !seed.location.country;
  return {
    ...payload,
    location: storedKnowsCountry ? payload.location : seed.location,
    season: seed.season,
    countryName: storedKnowsCountry
      ? payload.countryName
      : seed.countryName || payload.countryName,
  };
}

/** A live forecast for `seed`, with the country and height the forecast knows. */
export function liveViewFor(
  seed: PlaceSeed,
  weather: WeatherData,
  usingFallback: boolean,
): DashboardPayload {
  const location = reconcileElevation(
    reconcileCountry(seed.location, weather.timezone),
    weather.elevation,
  );
  return {
    location,
    weather,
    usingFallback,
    frostAlert: usingFallback
      ? null
      : checkFrostRisk(weather.hourly, weather.utc_offset_seconds),
    season: seed.season,
    countryName:
      location.country === seed.location.country
        ? seed.countryName
        : countryDisplayName(location.country),
  };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

// ── The controller ──────────────────────────────────────────────────────────

export interface PresentResult {
  /** The place is on screen (false: a newer request took over). */
  shown: boolean;
  /** A fetch failed and there is no live data for the place. */
  failed: boolean;
}

export interface PlaceController {
  getState(): PlaceState;
  subscribe(listener: () => void): () => void;
  /** Paint the seed's stored view and fetch what is missing (on mount). */
  start(): Promise<PresentResult>;
  /**
   * Make `seed` the place `/` shows (My Location). On the home place the
   * screen swaps in place and the URL stays `/`. While the visitor is on
   * another place the screen is left alone, unless `focus` (they asked for
   * "my location"): then it moves to `/`.
   */
  showHome(seed: PlaceSeed, opts?: { focus?: boolean }): Promise<PresentResult>;
  /** Show a place by slug (memory, device, catalogue, Worker, spot). */
  showSlug(slug: string, url?: UrlAction): Promise<boolean>;
  /** Show whatever a pathname names; false when it is not a place or unknown. */
  reconcile(pathname: string): Promise<boolean>;
  /** Show a target (used by the switch bus). */
  showTarget(target: PlaceTarget, url?: UrlAction): Promise<boolean>;
  /** Fetch the place on screen again. */
  retry(): Promise<PresentResult>;
  /** The place `/` shows, when this stage knows it. */
  homeSeed(): PlaceSeed | null;
  dispose(): void;
}

export function createPlaceController(
  deps: PlaceDeps,
  init: { seed: PlaceSeed | null; isHome: boolean; path: string },
): PlaceController {
  let state: PlaceState = {
    seed: init.seed,
    view: null,
    device: null,
    fetching: false,
    failed: false,
    isHome: init.isHome,
    path: init.path,
  };
  let home: PlaceSeed | null = init.isHome ? init.seed : null;
  const listeners = new Set<() => void>();
  const requests = createLatestRequests();

  const set = (patch: Partial<PlaceState>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const stored = async (slug: string): Promise<DeviceView | null> => {
    const mem = recallFromMemory(slug, deps.now());
    if (mem) return mem;
    return withTimeout(deps.recall(slug), deps.recallTimeoutMs ?? 400);
  };

  /** Fetch live weather for `seed` and put it on screen if still the latest. */
  async function refresh(
    req: LatestRequest,
    seed: PlaceSeed,
    held: DeviceView | null,
  ): Promise<PresentResult> {
    set({ fetching: true, failed: false });
    try {
      const { weather, usingFallback } = await deps.fetchWeather(
        seed.location.lat,
        seed.location.lon,
        req.signal,
      );
      const view = liveViewFor(seed, weather, usingFallback);
      const at = deps.now();
      // Kept even if the visitor already moved on: the request was paid for.
      rememberInMemory(view, at);
      if (!req.isLatest()) return { shown: false, failed: false };
      if (usingFallback && held) {
        // The seasonal estimate never replaces a real forecast.
        set({ fetching: false, failed: true });
        return { shown: true, failed: true };
      }
      set({
        seed: { ...seed, location: view.location },
        view,
        device: null,
        fetching: false,
        failed: false,
      });
      return { shown: true, failed: false };
    } catch {
      if (!req.isLatest()) return { shown: false, failed: false };
      set({ fetching: false, failed: true });
      return { shown: true, failed: true };
    }
  }

  async function present(
    req: LatestRequest,
    seed: PlaceSeed,
    opts: { isHome: boolean; url: UrlAction; found?: DeviceView | null },
  ): Promise<PresentResult> {
    const found =
      opts.found !== undefined ? opts.found : await stored(seed.location.slug);
    if (!req.isLatest()) return { shown: false, failed: false };

    const path = opts.isHome ? "/" : `/${seed.location.slug}`;
    if (opts.url !== "none" && deps.history.path() !== path) {
      if (opts.url === "push") deps.history.push(path);
      else deps.history.replace(path);
    }
    if (opts.isHome) home = seed;
    set({
      seed,
      view: found ? mergeStoredWithSeed(found.payload, seed) : null,
      device: found
        ? { fetchedAt: found.fetchedAt, freshness: found.freshness }
        : null,
      fetching: false,
      failed: false,
      isHome: opts.isHome,
      path,
    });
    deps.onShow?.({ seed, isHome: opts.isHome, url: opts.url });

    if (found && isFreshEnough(found, deps.now())) {
      return { shown: true, failed: false };
    }
    return refresh(req, seed, found);
  }

  const controller: PlaceController = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start() {
      if (!state.seed) return Promise.resolve({ shown: false, failed: false });
      return present(requests.begin(), state.seed, {
        isHome: state.isHome,
        url: "none",
      });
    },

    showHome(seed, opts = {}) {
      home = seed;
      // The visitor is looking at another place: remember where "My
      // Location" is, but do not pull the screen away from them.
      if (!state.isHome && !opts.focus) {
        return Promise.resolve({ shown: false, failed: false });
      }
      if (
        state.isHome &&
        state.seed?.location.slug === seed.location.slug &&
        state.view &&
        !state.device
      ) {
        return Promise.resolve({ shown: true, failed: false });
      }
      return present(requests.begin(), seed, {
        isHome: true,
        url: state.isHome ? "none" : "push",
      });
    },

    async showSlug(slug, url = "push") {
      const req = requests.begin();
      // A place we already hold needs no lookup.
      let found = recallFromMemory(slug, deps.now());
      let seed: PlaceSeed | null = found ? seedOfPayload(found.payload) : null;
      if (!seed) {
        found = await withTimeout(
          deps.recall(slug),
          deps.recallTimeoutMs ?? 400,
        );
        if (!req.isLatest()) return true;
        seed = found ? seedOfPayload(found.payload) : null;
      }
      if (!seed) {
        seed = await deps.resolve(slug, req.signal).catch(() => null);
        if (!req.isLatest()) return true;
        found = null;
      }
      if (!seed) return false;
      await present(req, seed, { isHome: false, url, found });
      return true;
    },

    async showTarget(target, url = "push") {
      if (target.kind === "slug") return controller.showSlug(target.slug, url);
      if (!home) return false;
      await present(requests.begin(), home, { isHome: true, url });
      return true;
    },

    async reconcile(pathname) {
      if (pathname === state.path) return true;
      const target = placeTargetOf(pathname);
      if (!target) return true; // another route: the router owns it
      if (pathOfTarget(target) === state.path) return true;
      return controller.showTarget(target, "none");
    },

    retry() {
      if (!state.seed) return Promise.resolve({ shown: false, failed: false });
      const req = requests.begin();
      const held: DeviceView | null =
        state.view && state.device
          ? {
              payload: state.view,
              freshness: state.device.freshness,
              fetchedAt: state.device.fetchedAt,
            }
          : null;
      return refresh(req, state.seed, held);
    },

    homeSeed: () => home,

    dispose() {
      requests.cancel();
      listeners.clear();
    },
  };
  return controller;
}
