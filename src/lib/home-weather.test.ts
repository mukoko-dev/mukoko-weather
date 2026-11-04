import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workerData } from "./worker-data";
import {
  fetchHomeWeather,
  fetchWorkerWeatherOnce,
  loadModelWeather,
} from "./home-weather";
import { createFallbackWeather } from "./weather";

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

  it("takes Apple Weather's own provider name as the chosen model (not open-meteo:)", async () => {
    const fetchMock = vi.fn(async () => respond("apple-weatherkit"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await loadModelWeather(-17.83, 31.05, "apple_weatherkit", [
      "apple_weatherkit",
      "ecmwf_ifs",
    ]);
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("model=apple_weatherkit");
    expect(result.ok && result.baseline).not.toBeNull();
  });

  it("an Apple pick answered with the blend is not swapped onto Apple", async () => {
    // Not configured, over budget, circuit open: the Worker serves the blend
    // and says so; the page must not label it Apple's forecast. The shared
    // read keeps an answer per cell, so each case starts from an empty store.
    for (const provider of [
      "open-meteo:blend",
      "open-meteo:best_match",
      // An Open-Meteo-looking header is never read as Apple.
      "open-meteo:apple_weatherkit",
    ]) {
      workerData.reset();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => respond(provider)),
      );
      const result = await loadModelWeather(-17.83, 31.05, "apple_weatherkit", [
        "apple_weatherkit",
      ]);
      expect(result.ok, provider).toBe(true);
      if (result.ok) expect(result.baseline, provider).toBeNull();
    }
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
});

describe("fetchWorkerWeatherOnce (the background read for a place not yet asked for)", () => {
  it("is one call through the shared read: a later switch to the same cell costs nothing", async () => {
    const fetchMock = vi.fn(async () => respond("open-meteo:blend"));
    vi.stubGlobal("fetch", fetchMock);
    const warmed = await fetchWorkerWeatherOnce(-17.83, 31.05);
    expect(warmed.usingFallback).toBe(false);
    await fetchHomeWeather(-17.83, 31.05);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never goes to the provider when the Worker fails: it throws after ONE attempt", async () => {
    const fetchMock = vi.fn(async () => failing(503));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWorkerWeatherOnce(-17.83, 31.05)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
    // Compare the HOST, never a substring of the whole URL: a path or a query
    // string that merely contains a host name is not that host.
    expect(
      urls.every((u) => new URL(u).hostname === "weather-api.mukoko.com"),
    ).toBe(true);
    expect(
      urls.some((u) => new URL(u).hostname.endsWith("open-meteo.com")),
    ).toBe(false);
  });

  it("never goes to the provider when the Worker cannot be reached either", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWorkerWeatherOnce(-17.83, 31.05)).rejects.toThrow();
    expect(
      fetchMock.mock.calls.some((c) =>
        new URL(String((c as unknown[])[0])).hostname.endsWith(
          "open-meteo.com",
        ),
      ),
    ).toBe(false);
  });

  it("refuses a body that is not a forecast", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "X-Weather-Provider": "open-meteo:blend" }),
        json: async () => ({ nope: true }),
      })),
    );
    await expect(fetchWorkerWeatherOnce(-17.83, 31.05)).rejects.toThrow();
  });

  it("says when the Worker only had the seasonal estimate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond("fallback")),
    );
    const result = await fetchWorkerWeatherOnce(-17.83, 31.05);
    expect(result.usingFallback).toBe(true);
  });
});
