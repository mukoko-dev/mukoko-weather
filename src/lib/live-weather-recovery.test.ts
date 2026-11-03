/**
 * The forecast recovers on its own (#414): the whole chain the dashboard runs,
 * from a seasonal-estimate seed to a cleared banner, against a fake Worker.
 *
 *   loadModelWeather (typed failure) -> createLiveFetch (retry, events)
 *     -> resolveDisplayedWeather -> weatherBanner
 *
 * Before: one failed client fetch was swallowed, there was no retry, and the
 * banner stayed up (it was tied to "no model baseline") even after the API
 * had recovered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { workerData } from "./worker-data";
import { loadModelWeather } from "./home-weather";
import {
  createLiveFetch,
  LIVE_EVENT_MIN_GAP_MS,
  type LiveFetch,
  type LiveFetchState,
} from "./live-fetch";
import {
  emptyModelExtras,
  modelExtrasFromResponse,
  modelExtrasKey,
  resolveDisplayedWeather,
  type ModelExtras,
} from "./dashboard-fetch-policy";
import { weatherBanner } from "./weather-banner";
import { reportLiveWeatherFailure } from "./live-weather-report";
import { createFallbackWeather, type WeatherData } from "./weather";

const seed = createFallbackWeather(-17.83, 31.05, 1483);
const liveWeather: WeatherData = {
  ...createFallbackWeather(-17.83, 31.05, 1483),
  current: { ...seed.current, temperature_2m: 27.5 },
};
const KEY = modelExtrasKey(-17.83, 31.05, "best_match");

type Reply = () => Response;
const live = (): Response =>
  new Response(JSON.stringify(liveWeather), {
    headers: { "X-Weather-Provider": "open-meteo:blend" },
  });
const status =
  (code: number, headers: Record<string, string> = {}) =>
  (): Response =>
    new Response("x", { status: code, headers });

/** The dashboard's chain, with a manual clock. */
function dashboard(opts: { seedIsFallback: boolean; replies: Reply[] }) {
  let t = 5_000_000;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  let extras: ModelExtras = emptyModelExtras(KEY);
  let state: LiveFetchState | null = null;
  const warnings: string[] = [];
  let i = 0;
  const fetchMock = vi.fn(async () => {
    const reply = opts.replies[Math.min(i, opts.replies.length - 1)];
    i++;
    return reply();
  });
  vi.stubGlobal("fetch", fetchMock);

  const fetchLive: LiveFetch = createLiveFetch<ModelExtras>({
    attempt: async ({ force }) => {
      const r = await loadModelWeather(-17.83, 31.05, "best_match", [], {
        force,
      });
      if (!r.ok) return r;
      if (r.fallback) {
        return { ok: false, failure: { kind: "server", status: 200 } };
      }
      return {
        ok: true,
        value: modelExtrasFromResponse(KEY, r.data, r.baseline, r.data),
      };
    },
    onValue: (v) => (extras = v),
    onState: (s) => (state = s),
    onFailure: (f, attempt) =>
      reportLiveWeatherFailure("harare", f, attempt, {
        warn: (ctx) => void warnings.push(ctx.message),
        analytics: () => undefined,
      }),
    schedule: (fn, ms) => {
      const timer = { at: t + ms, fn, live: true };
      timers.push(timer);
      return () => (timer.live = false);
    },
    now: () => t,
  });

  const flush = async () => {
    for (let n = 0; n < 20; n++) await new Promise((r) => setTimeout(r, 0));
  };
  return {
    fetchLive,
    fetchMock,
    warnings,
    flush,
    advance: async (ms: number) => {
      t += ms;
      for (const timer of timers) {
        if (timer.live && timer.at <= t) {
          timer.live = false;
          timer.fn();
        }
      }
      await flush();
    },
    /** What the page shows right now. */
    view() {
      const shown = resolveDisplayedWeather(seed, opts.seedIsFallback, extras);
      const banner = weatherBanner({
        fallback: shown.usingFallback,
        stale: false,
        live: state ?? {
          status: "idle",
          failure: null,
          attempt: 0,
          retryInMs: null,
        },
      });
      return { shown, banner, state };
    },
  };
}

beforeEach(() => {
  workerData.reset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the forecast recovers on its own", () => {
  it("a seasonal-estimate page retries, shows why, and clears the banner when the API is back", async () => {
    const d = dashboard({
      seedIsFallback: true,
      replies: [status(503), status(503), live],
    });
    expect(d.view().banner.show).toBe(true); // painted from the server's seed

    d.fetchLive.start();
    await d.flush();
    let v = d.view();
    expect(v.banner.show).toBe(true);
    expect(v.banner.reason).toBe("The forecast service is slow, retrying");

    await d.advance(2_000); // retry 1: 503 again
    expect(d.view().banner.show).toBe(true);

    await d.advance(5_000); // retry 2: live
    v = d.view();
    expect(v.banner.show).toBe(false);
    expect(v.shown.weather.current.temperature_2m).toBe(27.5);
    expect(v.shown.usingFallback).toBe(false);
    expect(d.fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a 429 waits for Retry-After before trying again, and says it is busy", async () => {
    const d = dashboard({
      seedIsFallback: true,
      replies: [status(429, { "Retry-After": "20" }), live],
    });
    d.fetchLive.start();
    await d.flush();
    expect(d.view().banner.reason).toBe("Busy right now, retrying");
    await d.advance(19_000);
    expect(d.fetchMock).toHaveBeenCalledTimes(1);
    await d.advance(1_000);
    expect(d.view().banner.show).toBe(false);
  });

  it("when every retry fails it stops, says so, and 'Try again' recovers it later", async () => {
    const d = dashboard({
      seedIsFallback: true,
      replies: [status(503), status(503), status(503), status(503), live],
    });
    d.fetchLive.start();
    await d.flush();
    await d.advance(2_000);
    await d.advance(5_000);
    await d.advance(15_000);
    expect(d.fetchMock).toHaveBeenCalledTimes(4);
    let v = d.view();
    expect(v.state?.status).toBe("failed");
    expect(v.banner.show).toBe(true);
    expect(v.banner.reason).toBe(
      "The forecast service is slow. Try again in a moment.",
    );
    expect(v.banner.canRetry).toBe(true);

    d.fetchLive.retryNow(); // the button
    await d.flush();
    v = d.view();
    expect(v.banner.show).toBe(false);
    expect(d.fetchMock).toHaveBeenCalledTimes(5);
  });

  it("offline: no timers burn attempts; the online event brings it back, with no reload", async () => {
    let online = false;
    vi.stubGlobal("navigator", {
      get onLine() {
        return online;
      },
    });
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    const d = dashboard({
      seedIsFallback: true,
      replies: [
        () => {
          throw new TypeError("Failed to fetch");
        },
        live,
      ],
    });
    d.fetchLive.start();
    await d.flush();
    expect(d.view().banner.reason).toBe(
      "You're offline: showing seasonal estimates",
    );
    await d.advance(60_000);
    expect(d.fetchMock).toHaveBeenCalledTimes(1);

    online = true;
    await d.advance(LIVE_EVENT_MIN_GAP_MS + 1);
    d.fetchLive.nudge("online");
    await d.flush();
    expect(d.view().banner.show).toBe(false);
    expect(d.fetchMock).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it("a Worker that answers with the seasonal estimate is retried, not mistaken for a recovery", async () => {
    const fallback = (): Response =>
      new Response(JSON.stringify(seed), {
        headers: { "X-Weather-Provider": "fallback" },
      });
    const d = dashboard({ seedIsFallback: true, replies: [fallback, live] });
    d.fetchLive.start();
    await d.flush();
    expect(d.view().banner.show).toBe(true);
    await d.advance(2_000);
    expect(d.view().banner.show).toBe(false);
  });

  it("every failure is reported with its route, kind and slug, never a URL or coordinates", async () => {
    const d = dashboard({
      seedIsFallback: true,
      replies: [status(503), live],
    });
    d.fetchLive.start();
    await d.flush();
    expect(d.warnings).toEqual(["live weather fetch failed: server"]);
  });

  it("a page that already has live weather shows no banner and is not changed by a later failure", async () => {
    const d = dashboard({ seedIsFallback: false, replies: [status(503)] });
    d.fetchLive.start();
    await d.flush();
    const v = d.view();
    expect(v.banner.show).toBe(false);
    expect(v.shown.weather).toBe(seed);
  });
});

describe("air quality and the weather banner are independent", () => {
  it("a failed /v1/air-quality (502) does not touch the weather banner state", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/v1/air-quality")) {
          return new Response("bad gateway", { status: 502 });
        }
        return live();
      }),
    );

    const aq = await workerData.read(
      "air-quality",
      { lat: -17.83, lon: 31.05 },
      { retries: 0 },
    );
    expect(aq.ok).toBe(false);
    expect(aq.failure).toEqual({ kind: "server", status: 502 });

    // The page's live seed, and its client fetch, are unaffected.
    const weather = await loadModelWeather(-17.83, 31.05, "best_match", []);
    expect(weather.ok).toBe(true);
    const banner = weatherBanner({
      fallback: false,
      stale: false,
      live: { status: "ok", failure: null, attempt: 1, retryInMs: null },
    });
    expect(banner.show).toBe(false);
    // ...and a weather failure leaves the air-quality answer alone.
    expect(
      workerData.peek("air-quality", { lat: -17.83, lon: 31.05 }),
    ).toBeUndefined();
    expect(calls.filter((c) => c.includes("/v1/air-quality"))).toHaveLength(1);
  });

  it("a failed weather fetch does not mark air quality unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) =>
        String(input).includes("/v1/weather")
          ? new Response("x", { status: 503 })
          : new Response(JSON.stringify({ aqi: 40 })),
      ),
    );
    const weather = await loadModelWeather(-17.83, 31.05, "best_match", []);
    expect(weather.ok).toBe(false);
    const aq = await workerData.read<{ aqi: number }>("air-quality", {
      lat: -17.83,
      lon: 31.05,
    });
    expect(aq).toMatchObject({ ok: true, data: { aqi: 40 } });
  });

  it("the banner's inputs are the weather payload and the weather fetch only", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const banner = readFileSync(
      resolve(__dirname, "weather-banner.ts"),
      "utf-8",
    );
    const dash = readFileSync(
      resolve(__dirname, "../app/[location]/WeatherDashboard.tsx"),
      "utf-8",
    );
    const bannerCall = dash.slice(
      dash.indexOf("const banner = weatherBanner({"),
      dash.indexOf("});", dash.indexOf("const banner = weatherBanner({")),
    );
    expect(banner.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(
      /air.?quality|aqi/i,
    );
    expect(bannerCall).not.toMatch(/air|aqi/i);
    expect(bannerCall).toContain("fallback: usingFallback");
    expect(bannerCall).toContain("live: live.state");
  });
});
