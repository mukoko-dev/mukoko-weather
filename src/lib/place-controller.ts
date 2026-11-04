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
 * - A failed request is retried by the shared recovery rules (live-fetch.ts:
 *   about 2 s, 5 s and 15 s, `Retry-After` honoured, one more attempt when
 *   the browser comes back online or the page becomes visible). Only when
 *   those are spent is `failed` set, which shows the "Couldn't load" notice.
 * - Those retries take about 22 s, so a place with nothing to show (no stored
 *   copy) is not left on a silent skeleton: SLOW_LOAD_AFTER_MS after a
 *   forecast was first asked for, `slow` is set, which shows one calm
 *   "still trying" line and "Try again" over the same skeleton. It does not
 *   change the retries; it only says they are happening. Pressing "Try again"
 *   (on that line, or on "Couldn't load" with nothing stored) shows the line,
 *   busy, until that attempt ends.
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
import { createLiveFetch, defaultSchedule, type LiveFetch } from "./live-fetch";
import { classifyTransportError } from "./worker-data";
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
  /**
   * The forecast has been asked for SLOW_LOAD_AFTER_MS ago or longer, nothing
   * is on screen to show meanwhile (`view` is null) and the retries have not
   * run out yet. Never set together with `failed`.
   */
  slow: boolean;
  /**
   * The visitor pressed "Try again" on the "still trying" line and that
   * attempt is in flight: the line stays up and its button shows "Trying…"
   * until the attempt ends. Only ever set together with `slow`.
   */
  trying: boolean;
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
  /**
   * Live weather from the Worker (the visitor's own request, through the
   * shared Worker read: one call per place, a remembered failure replayed).
   * `force`: read again past a remembered failure (the visitor pressed
   * "Try again").
   */
  fetchWeather(
    lat: number,
    lon: number,
    signal: AbortSignal,
    options?: { force?: boolean },
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
  /** Run `fn` after `ms`; returns the canceller. Default: setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

/**
 * How long the skeleton stands alone before the page says it is still trying
 * to reach the weather service (and offers "Try again"). The retries run for
 * about 22 s (2 s, 5 s, 15 s), far too long to say nothing; 8 s is past what
 * a healthy request takes, so a normal load never shows the line.
 */
export const SLOW_LOAD_AFTER_MS = 8_000;

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

const TIMED_OUT = Symbol("recall-timed-out");

// ── The controller ──────────────────────────────────────────────────────────

export interface PresentResult {
  /** The place is on screen (false: a newer request took over). */
  shown: boolean;
  /** A fetch failed and there is no live data for the place. */
  failed: boolean;
}

/**
 * What warming a place did: it was already held young enough (`fresh`), a
 * forecast was fetched and kept (`warmed`), nothing usable came back
 * (`failed`: the place is unknown, the request failed, or only the seasonal
 * estimate was served), or the caller gave up first (`skipped`).
 */
export type WarmResult = "fresh" | "warmed" | "failed" | "skipped";

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
  /**
   * Get a place the visitor may go to next ready before they ask: one forecast
   * request, kept in memory, so the switch paints from it at once. It shows
   * nothing, never touches the screen's state or the request that is on
   * screen, and never retries (one attempt; the switch itself retries). A
   * place held young enough costs nothing.
   */
  warm(target: PlaceTarget, signal?: AbortSignal): Promise<WarmResult>;
  /** Fetch the place on screen again, now ("Try again"). */
  retry(): Promise<PresentResult>;
  /** The browser came online / the page became visible: one more attempt if the last failed. */
  nudge(reason: "online" | "visible"): void;
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
    slow: false,
    trying: false,
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

  /**
   * The stored view for a place: memory at once, else the device. A device
   * that is slow (the database loads on first use) is not waited on past the
   * timeout, but its answer is still kept in `late` and used if it arrives
   * before the live forecast does.
   */
  const stored = async (
    slug: string,
  ): Promise<{
    found: DeviceView | null;
    late: Promise<DeviceView | null> | null;
  }> => {
    const mem = recallFromMemory(slug, deps.now());
    if (mem) return { found: mem, late: null };
    const pending = Promise.resolve(deps.recall(slug)).catch(() => null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), deps.recallTimeoutMs ?? 400);
    });
    const first = await Promise.race([pending, timedOut]);
    clearTimeout(timer);
    return first === TIMED_OUT
      ? { found: null, late: pending }
      : { found: first, late: null };
  };

  let live: LiveFetch | null = null;
  let settleLive: ((result: PresentResult) => void) | null = null;
  let cancelSlow: (() => void) | null = null;

  const schedule = deps.schedule ?? defaultSchedule;

  function stopSlowTimer(): void {
    cancelSlow?.();
    cancelSlow = null;
  }

  /**
   * Start the clock for the "still trying" line. When it runs out with no
   * forecast and nothing stored on screen, `slow` is set; it never touches the
   * retries. Cancelled by a forecast, by the retries running out and by
   * leaving the place.
   */
  function armSlow(req: LatestRequest): void {
    if (cancelSlow || state.slow) return;
    cancelSlow = schedule(() => {
      cancelSlow = null;
      if (!req.isLatest() || state.view || !state.fetching) return;
      set({ slow: true });
    }, SLOW_LOAD_AFTER_MS);
  }

  /** Stop retrying for a place the visitor left; release anyone waiting. */
  function stopLive(): void {
    live?.stop();
    live = null;
    stopSlowTimer();
    settleLive?.({ shown: false, failed: false });
    settleLive = null;
  }

  /**
   * A new request. It supersedes whatever the old one was saying (the "still
   * trying" line describes a fetch that is no longer running), except when it
   * is the visitor pressing "Try again" with nothing stored on screen
   * (`keepSlow`): then the line is up, busy, until the attempt ends.
   */
  const begin = (keepSlow = false): LatestRequest => {
    stopLive();
    if (!keepSlow && (state.slow || state.trying)) {
      set({ slow: false, trying: false });
    }
    return requests.begin();
  };

  /**
   * Fetch live weather for `seed` and put it on screen if still the latest.
   * Resolves at the first outcome (a forecast, or the first failure); the
   * retries carry on in the background and set `failed` only when spent.
   */
  function refresh(
    req: LatestRequest,
    seed: PlaceSeed,
    held: DeviceView | null,
    force = false,
    keepSlow = false,
  ): Promise<PresentResult> {
    stopLive();
    set({ fetching: true, failed: false, slow: keepSlow, trying: keepSlow });
    // The clock for the "still trying" line runs for the whole episode, from
    // the first attempt to the forecast (or to the retries running out). When
    // the line is already up (`keepSlow`) there is nothing to wait for.
    armSlow(req);
    return new Promise<PresentResult>((resolve) => {
      let settled = false;
      const settle = (result: PresentResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      settleLive = settle;

      const apply = (value: {
        weather: WeatherData;
        usingFallback: boolean;
      }) => {
        const view = liveViewFor(seed, value.weather, value.usingFallback);
        if (!req.isLatest()) return settle({ shown: false, failed: false });
        stopSlowTimer();
        if (value.usingFallback && held) {
          // The seasonal estimate never replaces a real forecast.
          set({ fetching: false, failed: true, slow: false, trying: false });
          return settle({ shown: true, failed: true });
        }
        set({
          seed: { ...seed, location: view.location },
          view,
          device: null,
          fetching: false,
          failed: false,
          slow: false,
          trying: false,
        });
        settle({ shown: true, failed: false });
      };

      const fetcher = createLiveFetch<{
        weather: WeatherData;
        usingFallback: boolean;
      }>({
        schedule,
        now: deps.now,
        attempt: async ({ force: retrying }) => {
          try {
            const value = await deps.fetchWeather(
              seed.location.lat,
              seed.location.lon,
              req.signal,
              { force: force || retrying },
            );
            // Kept even if the visitor has already moved on (the recovery
            // stops and drops the answer): the request was paid for.
            rememberInMemory(
              liveViewFor(seed, value.weather, value.usingFallback),
              deps.now(),
            );
            return { ok: true, value };
          } catch (err) {
            return { ok: false, failure: classifyTransportError(err) };
          }
        },
        onValue: apply,
        onState: (liveState) => {
          if (!req.isLatest()) return;
          if (liveState.status === "retrying") {
            // Still trying: the skeleton stays, no "Couldn't load" yet. If
            // the "still trying" line is already up it stays up, and its
            // button is free again (the attempt it was waiting for ended).
            set({ fetching: true, failed: false, trying: false });
            settle({ shown: true, failed: true });
          } else if (liveState.status === "failed") {
            // The retries are spent: the "Couldn't load" notice replaces it.
            stopSlowTimer();
            set({ fetching: false, failed: true, slow: false, trying: false });
            settle({ shown: true, failed: true });
          }
        },
      });
      live = fetcher;
      fetcher.start();
    });
  }

  async function present(
    req: LatestRequest,
    seed: PlaceSeed,
    opts: { isHome: boolean; url: UrlAction; found?: DeviceView | null },
  ): Promise<PresentResult> {
    let found: DeviceView | null;
    let late: Promise<DeviceView | null> | null = null;
    if (opts.found !== undefined) found = opts.found;
    else ({ found, late } = await stored(seed.location.slug));
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
      slow: false,
      trying: false,
      isHome: opts.isHome,
      path,
    });
    deps.onShow?.({ seed, isHome: opts.isHome, url: opts.url });

    // A slow device answer repaints the skeleton with the stored copy, unless
    // the live forecast (or another place) got there first.
    late?.then((view) => {
      if (
        !view ||
        !req.isLatest() ||
        state.view ||
        state.seed?.location.slug !== seed.location.slug
      ) {
        return;
      }
      stopSlowTimer();
      set({
        view: mergeStoredWithSeed(view.payload, seed),
        device: { fetchedAt: view.fetchedAt, freshness: view.freshness },
        slow: false,
        trying: false,
      });
    });

    if (found && isFreshEnough(found, deps.now())) {
      return { shown: true, failed: false };
    }
    return refresh(req, seed, found);
  }

  async function warm(
    target: PlaceTarget,
    signal?: AbortSignal,
  ): Promise<WarmResult> {
    if (signal?.aborted) return "skipped";
    const slug =
      target.kind === "slug" ? target.slug : (home?.location.slug ?? null);
    if (!slug) return "skipped";
    const young = (view: DeviceView): boolean =>
      isFreshEnough(view, deps.now());

    const mem = recallFromMemory(slug, deps.now());
    if (mem && young(mem)) return "fresh";
    let seed: PlaceSeed | null =
      target.kind === "home" ? home : mem ? seedOfPayload(mem.payload) : null;
    if (!seed) {
      const device = await withTimeout(
        Promise.resolve(deps.recall(slug)).catch(() => null),
        deps.recallTimeoutMs ?? 400,
      );
      if (signal?.aborted) return "skipped";
      if (device && young(device)) {
        // A copy from an earlier visit that is still young: keep it where a
        // switch reads first, so it does not wait for the device.
        rememberInMemory(device.payload, device.fetchedAt);
        return "fresh";
      }
      seed = device ? seedOfPayload(device.payload) : null;
    }
    const own = new AbortController();
    const sig = signal ?? own.signal;
    if (!seed) {
      seed = await deps.resolve(slug, sig).catch(() => null);
      if (signal?.aborted) return "skipped";
    }
    if (!seed) return "failed";
    try {
      const value = await deps.fetchWeather(
        seed.location.lat,
        seed.location.lon,
        sig,
      );
      // Kept even if the caller gave up meanwhile: the request was paid for.
      // The seasonal estimate is never kept (rememberInMemory refuses it).
      rememberInMemory(
        liveViewFor(seed, value.weather, value.usingFallback),
        deps.now(),
      );
      return value.usingFallback ? "failed" : "warmed";
    } catch {
      return "failed";
    }
  }

  const controller: PlaceController = {
    getState: () => state,
    warm,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start() {
      if (!state.seed) return Promise.resolve({ shown: false, failed: false });
      return present(begin(), state.seed, {
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
      return present(begin(), seed, {
        isHome: true,
        url: state.isHome ? "none" : "push",
      });
    },

    async showSlug(slug, url = "push") {
      const req = begin();
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
      await present(begin(), home, { isHome: true, url });
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
      // Pressed on the "still trying" line or on "Couldn't load" with nothing
      // stored on screen: the line is up straight away, busy, rather than a
      // silent skeleton for another 8 s.
      const keepSlow = (state.slow || state.failed) && !state.view;
      const req = begin(keepSlow);
      const held: DeviceView | null =
        state.view && state.device
          ? {
              payload: state.view,
              freshness: state.device.freshness,
              fetchedAt: state.device.fetchedAt,
            }
          : null;
      return refresh(req, state.seed, held, true, keepSlow);
    },

    nudge(reason) {
      live?.nudge(reason);
    },

    homeSeed: () => home,

    dispose() {
      stopLive();
      requests.cancel();
      listeners.clear();
    },
  };
  return controller;
}
