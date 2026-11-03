import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardPayload, DeviceView } from "./device-weather";
import type { PlaceSeed } from "./place-controller";
import type { WeatherData } from "./weather";

const recallPlace = vi.fn();
const rememberPlace = vi.fn();
vi.mock("./rxdb/weather-places", () => ({
  recallPlace: (...a: unknown[]) => recallPlace(...a),
  rememberPlace: (...a: unknown[]) => rememberPlace(...a),
}));
const fetchHomeWeather = vi.fn();
vi.mock("./home-weather", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./home-weather")>()),
  fetchHomeWeather: (...a: unknown[]) => fetchHomeWeather(...a),
}));

const { workerData } = await import("./worker-data");
const invalidate = vi.spyOn(workerData, "invalidate");
const { pageWeatherDeps, usePageWeather } = await import("./use-page-weather");
const { createPlaceController, clearPlaceMemory } =
  await import("./place-controller");

const SEED: PlaceSeed = {
  location: {
    slug: "harare",
    name: "Harare",
    province: "Harare",
    lat: -17.83,
    lon: 31.05,
    elevation: 1490,
    tags: ["city"],
    country: "ZW",
  },
  season: { name: "Dry season", localName: "Chirimo", description: "Dry" },
  countryName: "Zimbabwe",
};

/** A forecast that covers the next day, in the place's own (UTC+2) clock. */
function weatherNow(now: number): WeatherData {
  const hours = Array.from({ length: 48 }, (_, i) => {
    const t = new Date(now + (i - 2) * 3_600_000 + 2 * 3_600_000);
    return t.toISOString().slice(0, 13) + ":00";
  });
  const days = [0, 1, 2].map((d) =>
    new Date(now + d * 86_400_000 + 2 * 3_600_000).toISOString().slice(0, 10),
  );
  const fill = (v: number) => hours.map(() => v);
  return {
    timezone: "Africa/Harare",
    utc_offset_seconds: 7200,
    elevation: 1490,
    current: {
      time: hours[2],
      temperature_2m: 24,
      apparent_temperature: 24,
      relative_humidity_2m: 40,
      precipitation: 0,
      weather_code: 1,
      cloud_cover: 10,
      wind_speed_10m: 8,
      wind_direction_10m: 90,
      wind_gusts_10m: 12,
      uv_index: 7,
      surface_pressure: 1015,
      is_day: 1,
    },
    hourly: {
      time: hours,
      temperature_2m: fill(24),
      apparent_temperature: fill(24),
      relative_humidity_2m: fill(40),
      precipitation: fill(0),
      precipitation_probability: fill(0),
      weather_code: fill(1),
      cloud_cover: fill(10),
      wind_speed_10m: fill(8),
      wind_direction_10m: fill(90),
      wind_gusts_10m: fill(12),
      uv_index: fill(7),
      surface_pressure: fill(1015),
      is_day: fill(1),
    },
    daily: { time: days },
  } as unknown as WeatherData;
}

const NOW = Date.parse("2026-11-03T10:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  recallPlace.mockReset().mockResolvedValue(null);
  rememberPlace.mockReset();
  fetchHomeWeather.mockReset();
  invalidate.mockReset();
  clearPlaceMemory();
  workerData.reset();
});
afterEach(() => vi.useRealTimers());

describe("pageWeatherDeps", () => {
  it("recalls the stored copy through the device store", async () => {
    await pageWeatherDeps().recall("harare");
    expect(recallPlace).toHaveBeenCalledWith("harare");
  });

  it("reads the forecast through the shared read, past a remembered failure only on a retry", async () => {
    fetchHomeWeather.mockResolvedValue({ weather: {}, usingFallback: false });
    const deps = pageWeatherDeps();
    const signal = new AbortController().signal;
    await deps.fetchWeather(-17.83, 31.05, signal);
    expect(invalidate).not.toHaveBeenCalled();
    await deps.fetchWeather(-17.83, 31.05, signal, { force: true });
    expect(invalidate).toHaveBeenCalledWith("weather", {
      lat: -17.83,
      lon: 31.05,
    });
    expect(fetchHomeWeather).toHaveBeenCalledTimes(2);
    expect(fetchHomeWeather).toHaveBeenCalledWith(-17.83, 31.05);
  });

  it("never switches place: no lookup, and the URL is left alone", async () => {
    const deps = pageWeatherDeps();
    await expect(
      deps.resolve("bulawayo", new AbortController().signal),
    ).resolves.toBeNull();
    deps.history.push("/x");
    deps.history.replace("/x");
    expect(deps.history.path()).toBe("");
    expect(deps.onShow).toBeUndefined();
  });
});

describe("a page's weather, in the order the visitor sees it", () => {
  it("paints the stored copy first, with no request when it is fresh", async () => {
    const stored: DeviceView = {
      freshness: "current",
      fetchedAt: NOW - 5 * 60_000,
      payload: {
        location: SEED.location,
        weather: weatherNow(NOW),
        usingFallback: false,
        frostAlert: null,
        season: SEED.season,
        countryName: "Zimbabwe",
      } satisfies DashboardPayload,
    };
    recallPlace.mockResolvedValue(stored);
    const controller = createPlaceController(pageWeatherDeps(), {
      seed: SEED,
      isHome: false,
      path: "/harare",
    });
    await controller.start();
    const state = controller.getState();
    expect(state.view?.weather.current.temperature_2m).toBe(24);
    expect(state.device).not.toBeNull();
    expect(fetchHomeWeather).not.toHaveBeenCalled();
  });

  it("with nothing stored shows the skeleton, then the visitor's own forecast", async () => {
    let answer: (v: unknown) => void = () => {};
    fetchHomeWeather.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const controller = createPlaceController(pageWeatherDeps(), {
      seed: SEED,
      isHome: false,
      path: "/harare",
    });
    const started = controller.start();
    await vi.advanceTimersByTimeAsync(0);
    // The forecast is on its way and nothing is on screen: the skeleton.
    expect(controller.getState().view).toBeNull();
    expect(controller.getState().fetching).toBe(true);

    answer({ weather: weatherNow(NOW), usingFallback: false });
    await started;
    const state = controller.getState();
    expect(state.view?.weather.current.temperature_2m).toBe(24);
    expect(state.device).toBeNull();
    expect(state.fetching).toBe(false);
    expect(state.failed).toBe(false);
  });

  it("says it is still trying after a slow start, then that it could not load", async () => {
    fetchHomeWeather.mockRejectedValue(new Error("offline"));
    const controller = createPlaceController(pageWeatherDeps(), {
      seed: SEED,
      isHome: false,
      path: "/harare",
    });
    void controller.start();
    await vi.advanceTimersByTimeAsync(8_100);
    expect(controller.getState().slow).toBe(true);
    expect(controller.getState().view).toBeNull();
    // The retries (2 s, 5 s, 15 s) are spent: the final notice replaces it.
    await vi.advanceTimersByTimeAsync(30_000);
    const state = controller.getState();
    expect(state.failed).toBe(true);
    expect(state.slow).toBe(false);
    expect(state.view).toBeNull();
    controller.dispose();
  });
});

describe("usePageWeather, as the server renders it", () => {
  it("starts with no view, no notice and no request (server and browser agree)", () => {
    // The probe reports its state through the markup it renders.
    function Probe() {
      const { state, view } = usePageWeather(SEED);
      return createElement("p", {
        "data-view": String(view),
        "data-device": String(state.device),
        "data-failed": String(state.failed),
        "data-slow": String(state.slow),
        "data-fetching": String(state.fetching),
        "data-place": state.seed?.location.slug,
      });
    }
    const html = renderToString(createElement(Probe));
    expect(html).toContain('data-view="null"');
    expect(html).toContain('data-device="null"');
    expect(html).toContain('data-failed="false"');
    expect(html).toContain('data-slow="false"');
    expect(html).toContain('data-fetching="false"');
    expect(html).toContain('data-place="harare"');
    // Effects do not run on the server: nothing was read or fetched.
    expect(recallPlace).not.toHaveBeenCalled();
    expect(fetchHomeWeather).not.toHaveBeenCalled();
  });
});
