import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workerData } from "./worker-data";
import {
  DIRECT_FORECAST_TIMEOUT_MS,
  fetchHomeWeather,
  loadModelWeather,
} from "./home-weather";
import { createFallbackWeather } from "./weather";

// `fetchWeather` is the visitor's own request to Open-Meteo; the Worker is
// the stubbed `fetch`. Everything else in ./weather stays real.
const direct = vi.hoisted(() => ({ fetchWeather: vi.fn() }));
vi.mock("./weather", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./weather")>();
  return {
    ...actual,
    fetchWeather: (...args: Parameters<typeof actual.fetchWeather>) =>
      direct.fetchWeather(...args),
  };
});

function respond(provider: string, init: { status?: number } = {}) {
  const body = createFallbackWeather(-17.83, 31.05, 1483);
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: new Headers({ "X-Weather-Provider": provider }),
    json: async () => body,
  } as unknown as Response;
}

function failing(status: number, headers: Record<string, string> = {}) {
  return new Response("nope", { status, headers });
}

beforeEach(() => {
  workerData.reset();
  direct.fetchWeather.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadModelWeather (issue #246)", () => {
  it("asks our API for the selected model + comparison set", async () => {
    const fetchMock = vi.fn(async () => respond("open-meteo:gfs_seamless"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await loadModelWeather(-17.83, 31.05, "gfs_seamless", [
      "gfs_seamless",
      "ecmwf_ifs",
    ]);
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("weather-api.mukoko.com/v1/weather?");
    expect(url).toContain("model=gfs_seamless");
    expect(url).toContain("models=gfs_seamless%2Cecmwf_ifs");
    expect(result.ok && result.baseline).not.toBeNull();
  });

  it("the blend default never swaps the seeded baseline", async () => {
    const fetchMock = vi.fn(async () => respond("open-meteo:blend"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await loadModelWeather(-17.83, 31.05, "best_match", [
      "best_match",
      "ecmwf_ifs",
    ]);
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).not.toContain("model=");
    expect(url).toContain("models=ecmwf_ifs");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.baseline).toBeNull();
      expect(result.fallback).toBe(false);
      expect(result.data.current).toBeDefined();
    }
  });

  it("does not treat a fallen-back provider as the chosen model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond("open-meteo:best_match")),
    );
    const result = await loadModelWeather(-17.83, 31.05, "ecmwf_ifs", [
      "ecmwf_ifs",
    ]);
    expect(result.ok && result.baseline).toBeNull();
  });

  it("says when the Worker only had the seasonal estimate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond("fallback")),
    );
    const result = await loadModelWeather(-17.83, 31.05, "best_match", []);
    expect(result).toMatchObject({ ok: true, fallback: true });
  });

  it("returns the typed failure instead of swallowing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => failing(429, { "Retry-After": "12" })),
    );
    const limited = await loadModelWeather(-17.83, 31.05, "best_match", []);
    expect(limited).toEqual({
      ok: false,
      failure: { kind: "rate_limited", status: 429, retryAfterSeconds: 12 },
    });

    workerData.reset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => failing(503)),
    );
    expect(await loadModelWeather(1, 1, "best_match", [])).toEqual({
      ok: false,
      failure: { kind: "server", status: 503 },
    });

    workerData.reset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => failing(400)),
    );
    expect(await loadModelWeather(2, 2, "best_match", [])).toEqual({
      ok: false,
      failure: { kind: "invalid", status: 400 },
    });
  });

  it("a network error is a timeout or offline or server, by what the browser says", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    vi.stubGlobal("navigator", { onLine: false });
    expect(await loadModelWeather(1, 1, "best_match", [])).toEqual({
      ok: false,
      failure: { kind: "offline", status: 0 },
    });

    workerData.reset();
    vi.stubGlobal("navigator", { onLine: true });
    expect(await loadModelWeather(1, 1, "best_match", [])).toEqual({
      ok: false,
      failure: { kind: "server", status: 0 },
    });

    workerData.reset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("timed out", "TimeoutError");
      }),
    );
    expect(await loadModelWeather(1, 1, "best_match", [])).toEqual({
      ok: false,
      failure: { kind: "timeout", status: 0 },
    });
  });

  it("a body that is not a forecast is invalid, not a recovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ hello: "world" }), { status: 200 }),
      ),
    );
    expect(await loadModelWeather(1, 1, "best_match", [])).toEqual({
      ok: false,
      failure: { kind: "invalid", status: 200 },
    });
  });

  it("force reads past a remembered failure (a retry), a plain call does not", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failing(503))
      .mockResolvedValueOnce(respond("open-meteo:blend"));
    vi.stubGlobal("fetch", fetchMock);
    expect((await loadModelWeather(1, 1, "best_match", [])).ok).toBe(false);
    expect((await loadModelWeather(1, 1, "best_match", [])).ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const retried = await loadModelWeather(1, 1, "best_match", [], {
      force: true,
    });
    expect(retried.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchHomeWeather", () => {
  it("is one call for the same cell, however often it is asked", async () => {
    const fetchMock = vi.fn(async () => respond("open-meteo:blend"));
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([
      fetchHomeWeather(-17.83, 31.05),
      fetchHomeWeather(-17.8301, 31.0501),
    ]);
    await fetchHomeWeather(-17.83, 31.05);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe("when the Worker only has the seasonal estimate", () => {
    // Sembawang: not in the Worker's cache, and the Workers' shared egress was
    // being refused by Open-Meteo (HTTP 429), so the Worker answered `fallback`.
    const LAT = 1.4439557246543009;
    const LON = 103.8244683875342;

    function live() {
      const weather = createFallbackWeather(LAT, LON, 8);
      weather.current.temperature_2m = 31.5;
      return weather;
    }

    it("asks Open-Meteo from the browser and shows that forecast", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => respond("fallback")),
      );
      const forecast = live();
      direct.fetchWeather.mockResolvedValue(forecast);
      const result = await fetchHomeWeather(LAT, LON);
      expect(result).toEqual({ weather: forecast, usingFallback: false });
      // Coarsened like every other client fetch of a derived place, with a
      // budget shorter than the library default.
      expect(direct.fetchWeather).toHaveBeenCalledWith(
        1.444,
        103.824,
        undefined,
        DIRECT_FORECAST_TIMEOUT_MS,
      );
    });

    it("keeps the Worker's estimate, flagged, when the browser cannot get a forecast either", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => respond("fallback")),
      );
      direct.fetchWeather.mockRejectedValue(
        new Error("Weather API error: 429"),
      );
      const result = await fetchHomeWeather(LAT, LON);
      expect(result.usingFallback).toBe(true);
      // The Worker's own body, not anything from the browser.
      expect(result.weather.current.temperature_2m).toBe(
        createFallbackWeather(-17.83, 31.05, 1483).current.temperature_2m,
      );
    });

    it("does not take a body that is not a forecast from the browser", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => respond("fallback")),
      );
      direct.fetchWeather.mockResolvedValue({ hourly: {} });
      const result = await fetchHomeWeather(LAT, LON);
      expect(result.usingFallback).toBe(true);
    });

    it("never calls Open-Meteo itself while the Worker has a live forecast", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => respond("open-meteo:blend")),
      );
      const result = await fetchHomeWeather(LAT, LON);
      expect(result.usingFallback).toBe(false);
      expect(direct.fetchWeather).not.toHaveBeenCalled();
    });

    it("still goes straight to Open-Meteo when the Worker cannot be reached", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("Failed to fetch");
        }),
      );
      const forecast = live();
      direct.fetchWeather.mockResolvedValue(forecast);
      const result = await fetchHomeWeather(LAT, LON);
      expect(result).toEqual({ weather: forecast, usingFallback: false });
    });
  });
});
