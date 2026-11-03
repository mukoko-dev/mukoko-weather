"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { DashboardPayload } from "./device-weather";
import { fetchHomeWeather } from "./home-weather";
import {
  createPlaceController,
  type PlaceDeps,
  type PlaceSeed,
  type PlaceState,
} from "./place-controller";
import { recallPlace, rememberPlace } from "./rxdb/weather-places";
import { useAppStore } from "./store";
import { workerData } from "./worker-data";

/**
 * How weather reaches a page that is NOT the place stage: `/[location]/forecast`
 * and `/[location]/atmosphere` (issue #452).
 *
 * The server sends the shell, the place and its season, never weather (the
 * same rule as `/` and `/[location]`, #414). The visitor's own browser then
 * gets the forecast the way the place stage does, because it is the same
 * state machine (`place-controller.ts`):
 *
 *   1. the copy already in memory (the place page was open a moment ago), else
 *      the copy stored on the device, painted at once;
 *   2. the visitor's own request through the shared Worker read
 *      (`worker-data.ts`: one call per place, a failure replayed briefly),
 *      retried after about 2 s, 5 s and 15 s, `Retry-After` honoured, one more
 *      attempt when the browser comes back online;
 *   3. while that runs with nothing to show, `slow` says so after 8 s, and
 *      `failed` says the retries are spent. A page reads these two flags to
 *      float the calm "Still trying…" / "Couldn't load · Try again" notice.
 *
 * The page has nothing else to switch to: no URL is pushed, no cookie or
 * title is written, and it does not register on the place-switch bus (a lane
 * chip from here must navigate normally to the other place).
 */
export function pageWeatherDeps(): PlaceDeps {
  return {
    now: () => Date.now(),
    recall: (slug) => recallPlace(slug),
    // Through the shared Worker read via fetchHomeWeather: never a raw Worker
    // call. "Try again" reads past the failure the store remembers.
    fetchWeather: (lat, lon, _signal, options) => {
      if (options?.force) workerData.invalidate("weather", { lat, lon });
      return fetchHomeWeather(lat, lon);
    },
    // A page that is not the stage never switches place.
    resolve: () => Promise.resolve(null),
    history: { path: () => "", push: () => {}, replace: () => {} },
  };
}

/** The slugs the device keeps even when it is short of space. */
function pinnedSlugs(): string[] {
  const { savedLocations, homeLocation, selectedLocation } =
    useAppStore.getState();
  return [
    ...savedLocations,
    ...(homeLocation ? [homeLocation] : []),
    ...(selectedLocation ? [selectedLocation] : []),
  ];
}

export interface PageWeather {
  /** The whole state: `view`, `device`, `fetching`, `failed`, `slow`, `trying`. */
  state: PlaceState;
  /** The weather on screen for the place; null while the page shows its skeleton. */
  view: DashboardPayload | null;
  /** "Try again": the same read, past a remembered failure. A request, not a reload. */
  retry: () => void;
}

/**
 * The weather for ONE place on a page that was served without it. The hook is
 * created for one place: render the page with `key={location.slug}`.
 *
 * The first render (the server's, and the browser's hydration render) always
 * has `view: null`, so server and browser agree; the stored copy and the live
 * forecast arrive after mount.
 */
export function usePageWeather(seed: PlaceSeed): PageWeather {
  const [controller] = useState(() =>
    createPlaceController(pageWeatherDeps(), {
      seed,
      isHome: false,
      path: `/${seed.location.slug}`,
    }),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );

  useEffect(() => {
    void controller.start();
    return () => controller.dispose();
  }, [controller]);

  // The browser coming back online, or the page becoming visible again, is
  // one more attempt for a forecast that has not arrived (live-fetch.ts).
  useEffect(() => {
    const onOnline = () => controller.nudge("online");
    const onVisible = () => {
      if (document.visibilityState === "visible") controller.nudge("visible");
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [controller]);

  // A forecast that came off the network is kept on the device, so the next
  // visit (even straight to this page) paints from it. Never the seasonal
  // estimate, never a copy that was itself read from memory or the device.
  const live = state.device === null ? state.view : null;
  useEffect(() => {
    if (!live || live.usingFallback) return;
    void rememberPlace(live, { pinned: pinnedSlugs() });
  }, [live]);

  const retry = useCallback(() => void controller.retry(), [controller]);
  return { state, view: state.view, retry };
}
