import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// No database in tests: SSR reads only the
// Worker, which is what these tests exercise.
vi.mock("./mongo", () => {
  const fail = () => {
    throw new Error("no db in tests");
  };
  return {
    default: {},
    weatherDb: fail,
    placesDb: fail,
    identityDb: fail,
    shamwariDb: fail,
    deviceDb: fail,
    integrationsDb: fail,
    platformDb: fail,
    entityDb: fail,
  };
});

import {
  getWeatherForLocation,
  SSR_HEDGE_AFTER_MS,
  SSR_WORKER_TIMEOUT_MS,
} from "./db";

const PY_PAYLOAD = {
  latitude: -17.83,
  longitude: 31.05,
  current: { temperature_2m: 22, weather_code: 1 },
  hourly: { time: [] },
  daily: { time: [] },
};

function json(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("getWeatherForLocation reads the Rust Worker only", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("asks weather-api.mukoko.com/v1/weather, with the page slug as the history key", async () => {
    fetchMock.mockResolvedValueOnce(
      json(PY_PAYLOAD, { "x-weather-provider": "open-meteo:blend" }),
    );

    const result = await getWeatherForLocation("harare", -17.83, 31.05, 1490);

    expect(result.source).toBe("open-meteo:blend");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://weather-api.mukoko.com/v1/weather?lat=-17.83&lon=31.05&location=harare",
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("never touches /api/py", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await getWeatherForLocation("harare", -17.83, 31.05, 1490).catch(() => 0);
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain("/api/py");
    }
  });

  it("does not parse an HTML 200", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response("<!DOCTYPE html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      )
      .mockResolvedValueOnce(json(PY_PAYLOAD));

    const result = await getWeatherForLocation("harare", -17.83, 31.05, 1490);

    expect(result.source).toBe("open-meteo");
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged.meta.contentType).toContain("text/html");
  });

  it("logs the real network error when the Worker is unreachable", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(json(PY_PAYLOAD));

    await getWeatherForLocation("harare", -17.83, 31.05, 1490);

    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged.message).toContain("Worker unreachable");
    expect(logged.errorName).toBe("TypeError");
  });
});

describe("SSR weather latency budget (iOS standalone blank launch)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A fetch that never answers until its abort signal fires. */
  const hang = (_url: unknown, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "TimeoutError")),
      );
    });

  it("keeps the budget well under the old 15 s", () => {
    expect(SSR_WORKER_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    expect(SSR_HEDGE_AFTER_MS).toBeLessThan(SSR_WORKER_TIMEOUT_MS);
  });

  it("a silent endpoint is hedged by direct Open-Meteo and the faster one wins", async () => {
    fetchMock.mockImplementation(
      (url: string, init?: { signal?: AbortSignal }) =>
        String(url).includes("/v1/weather")
          ? hang(url, init)
          : Promise.resolve(json(PY_PAYLOAD)),
    );

    const pending = getWeatherForLocation("harare", -17.83, 31.05, 1490);
    await vi.advanceTimersByTimeAsync(SSR_HEDGE_AFTER_MS + 10);
    const result = await pending;

    expect(result.source).toBe("open-meteo");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an endpoint that answers inside the hedge window never triggers the direct read", async () => {
    fetchMock.mockResolvedValue(
      json(PY_PAYLOAD, { "x-weather-provider": "blend" }),
    );

    const result = await getWeatherForLocation("harare", -17.83, 31.05, 1490);

    expect(result.source).toBe("blend");
    await vi.advanceTimersByTimeAsync(SSR_HEDGE_AFTER_MS + 10);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("when everything hangs the seasonal estimate arrives inside the budget", async () => {
    fetchMock.mockImplementation(hang);

    const pending = getWeatherForLocation("harare", -17.83, 31.05, 1490);
    await vi.advanceTimersByTimeAsync(SSR_WORKER_TIMEOUT_MS + 100);
    const result = await pending;

    expect(result.source).toBe("fallback");
  });
});
