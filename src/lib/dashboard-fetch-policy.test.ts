import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  emptyModelExtras,
  MODEL_EXTRAS_IDLE_TIMEOUT_MS,
  MODEL_EXTRAS_ROOT_MARGIN,
  modelExtrasFromResponse,
  modelExtrasKey,
  resolveDisplayedWeather,
  selectModelExtras,
  shouldFetchModelExtras,
} from "./dashboard-fetch-policy";
import type { WeatherData } from "./weather";

const dashboard = readFileSync(
  resolve(__dirname, "../app/[location]/WeatherDashboard.tsx"),
  "utf-8",
);
import { isNearViewport } from "./use-near-viewport";

describe("shouldFetchModelExtras", () => {
  it("waits for the end of the main column with the default blend", () => {
    expect(shouldFetchModelExtras("best_match", false)).toBe(false);
    expect(shouldFetchModelExtras("best_match", true)).toBe(true);
  });

  it("fetches a picked model at once (it becomes the page baseline)", () => {
    expect(shouldFetchModelExtras("gfs_seamless", false)).toBe(true);
    expect(shouldFetchModelExtras("ecmwf_ifs", false)).toBe(true);
  });

  it("uses a generous prefetch margin", () => {
    expect(
      Number.parseInt(MODEL_EXTRAS_ROOT_MARGIN, 10),
    ).toBeGreaterThanOrEqual(800);
  });
});

describe("isNearViewport", () => {
  it("follows the observer entry", () => {
    expect(isNearViewport({ isIntersecting: true })).toBe(true);
    expect(isNearViewport({ isIntersecting: false })).toBe(false);
  });
});

describe("dashboard wiring — below-the-fold fetches are deferred", () => {
  const atmospheric = readFileSync(
    resolve(__dirname, "../components/weather/AtmosphericSummary.tsx"),
    "utf-8",
  );

  it("gates the models/nowcast fetch on shouldFetchModelExtras (near OR first idle)", () => {
    expect(dashboard).toContain(
      "shouldFetchModelExtras(model, extrasNear || afterIdle)",
    );
    // Re-armed per place: the dashboard stays mounted across place switches.
    expect(dashboard).toContain(
      "useIdleOnce(MODEL_EXTRAS_IDLE_TIMEOUT_MS, location.slug)",
    );
    // The deferred gate still holds for a page that already has live weather;
    // a page showing the seasonal estimate fetches at once (#414).
    expect(dashboard).toContain("enabled: fetchExtras || seedUsingFallback,");
  });

  it("observes an out-of-flow sentinel at the end of the main column", () => {
    expect(dashboard).toContain("ref={extrasSentinelRef}");
    expect(dashboard).toContain("absolute bottom-0");
  });

  it("fetches climate normals only once the Conditions grid is near", () => {
    expect(atmospheric).toContain('useNearViewport(sectionRef, "600px")');
    // The shared hook fetches nothing while it is not enabled.
    expect(atmospheric).toContain("enabled && hasPoint");
    const hook = readFileSync(
      resolve(__dirname, "use-worker-data.ts"),
      "utf-8",
    );
    expect(hook).toContain("if (!enabled) return;");
  });
});

describe("model extras follow the place + model on screen (review finding 1)", () => {
  const gfsBaseline = {
    current: { temperature_2m: -1 },
  } as unknown as WeatherData;
  const gfsKey = modelExtrasKey(-17.83, 31.05, "gfs_seamless");
  const blendKey = modelExtrasKey(-17.83, 31.05, "best_match");
  const loadedGfs = modelExtrasFromResponse(
    gfsKey,
    {
      minutely: { time: ["t"], precipitation: [1] } as never,
      models: [{ model: "gfs_seamless" }] as never,
      models_time: ["t"],
    },
    gfsBaseline,
  );

  it("uses the loaded extras while the same model is on screen", () => {
    const shown = selectModelExtras(loadedGfs, gfsKey);
    expect(shown.baseline).toBe(gfsBaseline);
    expect(shown.series).toHaveLength(1);
    expect(shown.minutely).not.toBeNull();
  });

  it("switching back to best_match drops the old model's baseline, nowcast and series at once", () => {
    const shown = selectModelExtras(loadedGfs, blendKey);
    expect(shown.baseline).toBeNull(); // seed (blend) is the baseline again
    expect(shown.minutely).toBeNull();
    expect(shown.series).toEqual([]);
    expect(shown.time).toEqual([]);
    expect(shown.key).toBe(blendKey);
  });

  it("a different place never shows another place's extras", () => {
    const elsewhere = modelExtrasKey(-20.15, 28.58, "gfs_seamless");
    expect(selectModelExtras(loadedGfs, elsewhere).baseline).toBeNull();
  });

  it("keys round like the API (2 dp) and default an empty model to the blend", () => {
    expect(modelExtrasKey(-17.8312, 31.0499, "")).toBe(
      "-17.83,31.05:best_match",
    );
  });

  it("starts empty", () => {
    expect(emptyModelExtras(blendKey)).toEqual({
      key: blendKey,
      baseline: null,
      live: null,
      minutely: null,
      series: [],
      time: [],
    });
  });

  it("the dashboard renders only selectModelExtras' result, never raw loaded state", () => {
    const hook = readFileSync(
      resolve(__dirname, "use-live-weather.ts"),
      "utf-8",
    );
    // The hook hands out only extras fetched for the place + model on screen.
    expect(hook).toContain(
      "extras: loaded?.key === extrasKey ? loaded : emptyModelExtras(extrasKey)",
    );
    expect(dashboard).toContain("const extras = live.extras ?? ");
    expect(dashboard).toContain("resolveDisplayedWeather(");
    expect(dashboard).not.toContain("setModelBaseline(");
  });

  it("starts at idle within 2.5 s", () => {
    expect(MODEL_EXTRAS_IDLE_TIMEOUT_MS).toBeLessThanOrEqual(2500);
  });
});

describe("resolveDisplayedWeather (#414: the banner follows the data on screen)", () => {
  const seed = { current: { temperature_2m: 21 } } as unknown as WeatherData;
  const liveBlend = {
    current: { temperature_2m: 24 },
  } as unknown as WeatherData;
  const gfs = { current: { temperature_2m: 25 } } as unknown as WeatherData;
  const key = modelExtrasKey(-17.83, 31.05, "best_match");

  it("a live seed stays as it is, and a fetch that finds nothing changes nothing", () => {
    const shown = resolveDisplayedWeather(seed, false, emptyModelExtras(key));
    expect(shown).toEqual({
      weather: seed,
      override: null,
      usingFallback: false,
    });
    // Even a live forecast arriving later does not replace a live seed.
    const later = modelExtrasFromResponse(key, liveBlend, null, liveBlend);
    expect(resolveDisplayedWeather(seed, false, later).weather).toBe(seed);
  });

  it("a seasonal-estimate seed stays on screen, flagged, until live data arrives", () => {
    const shown = resolveDisplayedWeather(seed, true, emptyModelExtras(key));
    expect(shown).toEqual({
      weather: seed,
      override: null,
      usingFallback: true,
    });
  });

  it("the first live forecast replaces a seasonal-estimate seed and clears the flag, with no picked model", () => {
    const recovered = modelExtrasFromResponse(key, liveBlend, null, liveBlend);
    const shown = resolveDisplayedWeather(seed, true, recovered);
    expect(shown.weather).toBe(liveBlend);
    expect(shown.override).toBe(liveBlend);
    expect(shown.usingFallback).toBe(false);
  });

  it("a picked model's baseline wins and is never a fallback", () => {
    const picked = modelExtrasFromResponse(key, gfs, gfs, gfs);
    const shown = resolveDisplayedWeather(seed, true, picked);
    expect(shown.weather).toBe(gfs);
    expect(shown.usingFallback).toBe(false);
  });

  it("a failed or empty fetch never clears the flag on its own", () => {
    expect(
      resolveDisplayedWeather(seed, true, emptyModelExtras(key)).usingFallback,
    ).toBe(true);
  });
});
