"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  emptyModelExtras,
  modelExtrasFromResponse,
  type ModelExtras,
} from "./dashboard-fetch-policy";
import { loadModelWeather } from "./home-weather";
import {
  createLiveFetch,
  type LiveFetch,
  type LiveFetchState,
} from "./live-fetch";
import { reportLiveWeatherFailure } from "./live-weather-report";

const IDLE: LiveFetchState = {
  status: "idle",
  failure: null,
  attempt: 0,
  retryInMs: null,
};

export interface UseLiveWeatherInput {
  /** Fetch now (the deferred-extras gate, or the page is on the seasonal estimate). */
  enabled: boolean;
  /**
   * The page is showing the seasonal estimate (or a picked model's baseline
   * is awaited): recovery is the point, so retry fully. Otherwise this fetch
   * only feeds optional cards (comparison, nowcast) and retries once.
   */
  recover: boolean;
  /** Identity of the place + model (`modelExtrasKey`). */
  extrasKey: string;
  slug: string;
  lat: number;
  lon: number;
  model: string;
  /** The comparison set, comma-joined (a stable dependency). */
  modelsKey: string;
}

/**
 * The dashboard's client fetch of `/v1/weather` (model comparison, nowcast, a
 * picked model's baseline, and the live forecast that replaces a seasonal
 * estimate), with the recovery rules of `live-fetch.ts`: typed failures,
 * retry after about 2 s, 5 s and 15 s, one more attempt when the browser comes
 * back online or the page becomes visible, and `retryNow` for "Try again".
 * Failures are reported, never swallowed (#414).
 */
export function useLiveWeather(input: UseLiveWeatherInput): {
  extras: ModelExtras | null;
  state: LiveFetchState;
  retryNow: () => void;
} {
  const { enabled, recover, extrasKey, slug, lat, lon, model, modelsKey } =
    input;
  const [loaded, setLoaded] = useState<ModelExtras | null>(null);
  const [tracked, setTracked] = useState<{
    key: string;
    state: LiveFetchState;
  } | null>(null);
  const controllerRef = useRef<LiveFetch | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const models = Array.from(
      new Set([model, ...modelsKey.split(",").filter(Boolean)]),
    );
    const fetchLive = createLiveFetch<ModelExtras>({
      maxRetries: recover ? undefined : 1,
      attempt: async ({ force }) => {
        const r = await loadModelWeather(lat, lon, model, models, { force });
        if (!r.ok) return r;
        // The Worker answered with the seasonal estimate: no provider is
        // reachable yet, so this is a failure to retry, not a recovery.
        if (r.fallback) {
          return { ok: false, failure: { kind: "server", status: 200 } };
        }
        return {
          ok: true,
          value: modelExtrasFromResponse(extrasKey, r.data, r.baseline, r.data),
        };
      },
      onValue: (extras) => setLoaded(extras),
      onState: (state) => setTracked({ key: extrasKey, state }),
      onFailure: (failure, attempt) =>
        reportLiveWeatherFailure(slug, failure, attempt),
    });
    controllerRef.current = fetchLive;

    const onOnline = () => fetchLive.nudge("online");
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchLive.nudge("visible");
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    fetchLive.start();

    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      fetchLive.stop();
      if (controllerRef.current === fetchLive) controllerRef.current = null;
    };
  }, [enabled, recover, extrasKey, slug, lat, lon, model, modelsKey]);

  const retryNow = useCallback(() => controllerRef.current?.retryNow(), []);

  return {
    extras: loaded?.key === extrasKey ? loaded : emptyModelExtras(extrasKey),
    state: tracked?.key === extrasKey ? tracked.state : IDLE,
    retryNow,
  };
}
