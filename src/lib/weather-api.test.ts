import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEFAULT_WEATHER_API_URL,
  WORKER_AI_TIMEOUT_MS,
  WORKER_TIMEOUT_MS,
  fetchPlaces,
  fetchWorker,
  postWorker,
  weatherApiBase,
  workerErrorMessage,
  workerUrl,
} from "./weather-api";

const ON = { NEXT_PUBLIC_WEATHER_API_URL: "https://weather-api.mukoko.com/" };

describe("weatherApiBase", () => {
  it("defaults to the production Worker, so no env var is needed", () => {
    expect(DEFAULT_WEATHER_API_URL).toBe("https://weather-api.mukoko.com");
    expect(weatherApiBase({})).toBe(DEFAULT_WEATHER_API_URL);
    expect(weatherApiBase({ NEXT_PUBLIC_WEATHER_API_URL: "  " })).toBe(
      DEFAULT_WEATHER_API_URL,
    );
  });

  it("returns a bare https origin override", () => {
    expect(
      weatherApiBase({
        NEXT_PUBLIC_WEATHER_API_URL: "https://staging-api.example.com/",
      }),
    ).toBe("https://staging-api.example.com");
    expect(weatherApiBase(ON)).toBe("https://weather-api.mukoko.com");
  });

  it("allows plain http only for localhost", () => {
    expect(
      weatherApiBase({ NEXT_PUBLIC_WEATHER_API_URL: "http://localhost:8787" }),
    ).toBe("http://localhost:8787");
    expect(
      weatherApiBase({ NEXT_PUBLIC_WEATHER_API_URL: "http://weather.test" }),
    ).toBe(DEFAULT_WEATHER_API_URL);
  });

  it.each([
    "not a url",
    "https://user:pw@weather.test",
    "https://weather.test/?x=1",
    "https://weather.test/#x",
    "ftp://weather.test",
  ])(
    "a bad override (%s) never redirects traffic: the default stands",
    (url) => {
      expect(weatherApiBase({ NEXT_PUBLIC_WEATHER_API_URL: url })).toBe(
        DEFAULT_WEATHER_API_URL,
      );
    },
  );
});

describe("workerUrl", () => {
  it("builds /v1 URLs on the Worker", () => {
    expect(workerUrl("geo", "lat=1&lon=2", {})).toBe(
      "https://weather-api.mukoko.com/v1/geo?lat=1&lon=2",
    );
    expect(workerUrl("air-quality", "lat=1&lon=2", {})).toBe(
      "https://weather-api.mukoko.com/v1/air-quality?lat=1&lon=2",
    );
    expect(workerUrl("airports/nearest", "", {})).toBe(
      "https://weather-api.mukoko.com/v1/airports/nearest",
    );
  });
});

describe("fetchWorker", () => {
  const res = (status: number) => new Response("{}", { status });
  const opts = (fetcher: unknown) => ({ env: {}, fetcher: fetcher as never });

  it("calls only the Worker, never /api/py", async () => {
    const fetcher = vi.fn(async (_u: string, _i?: RequestInit) => res(200));
    await fetchWorker("weather", "lat=1&lon=2", {}, opts(fetcher));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://weather-api.mukoko.com/v1/weather?lat=1&lon=2",
    );
  });

  it("treats a 4xx as the answer, with no retry", async () => {
    const fetcher = vi.fn(async (_u: string, _i?: RequestInit) => res(404));
    const out = await fetchWorker("geo", "x=1", {}, opts(fetcher));
    expect(out.status).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([500, 502, 503])(
    "retries a %i once on the Worker",
    async (status) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(res(status))
        .mockResolvedValueOnce(res(200));
      const out = await fetchWorker("geo", "x=1", {}, opts(fetcher));
      expect(out.status).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(String(fetcher.mock.calls[1][0])).toContain("/v1/geo?x=1");
    },
  );

  it("returns the second 5xx instead of falling back anywhere", async () => {
    const fetcher = vi.fn().mockResolvedValue(res(503));
    const out = await fetchWorker("geo", "x=1", {}, opts(fetcher));
    expect(out.status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries a network error once, then throws", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("network"));
    await expect(
      fetchWorker("search", "q=a", {}, opts(fetcher)),
    ).rejects.toThrow("network");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("gives every attempt a timeout signal", async () => {
    const fetcher = vi.fn(async (_u: string, _i?: RequestInit) => res(200));
    await fetchWorker("weather", "x=1", {}, opts(fetcher));
    expect(fetcher.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not retry an aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi
      .fn()
      .mockRejectedValue(new DOMException("aborted", "AbortError"));
    await expect(
      fetchWorker("geo", "x=1", { signal: controller.signal }, opts(fetcher)),
    ).rejects.toThrow();
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("postWorker (the AI routes)", () => {
  const opts = (fetcher: unknown, extra = {}) => ({
    env: {},
    fetcher: fetcher as never,
    ...extra,
  });

  it("POSTs JSON to /v1/<route> on the Worker, once", async () => {
    const fetcher = vi.fn(
      async (_u: string, _i?: RequestInit) => new Response("{}"),
    );
    await postWorker("ai/explore/search", { query: "warm" }, opts(fetcher));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://weather-api.mukoko.com/v1/ai/explore/search",
    );
    const init = fetcher.mock.calls[0][1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"query":"warm"}');
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("never retries: a model call costs and counts against an hourly budget", async () => {
    const fetcher = vi.fn(
      async (_u: string, _i?: RequestInit) =>
        new Response("{}", { status: 503 }),
    );
    const out = await postWorker("ai/history/analyze", {}, opts(fetcher));
    expect(out.status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const failing = vi.fn().mockRejectedValue(new TypeError("network"));
    await expect(
      postWorker("ai/history/analyze", {}, opts(failing)),
    ).rejects.toThrow("network");
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("gives a model call a longer ceiling than a read", () => {
    expect(WORKER_AI_TIMEOUT_MS).toBeGreaterThan(WORKER_TIMEOUT_MS);
  });
});

describe("workerErrorMessage", () => {
  const msg = (body: unknown, status = 400) =>
    workerErrorMessage(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
      }),
    );

  it("reads the Workers' envelope", async () => {
    expect(
      await msg(
        { error: "rate_limited", error_description: "Try later." },
        429,
      ),
    ).toBe("Try later.");
    expect(await msg({ error: "no_history" }, 404)).toBe("no_history");
  });

  it("falls back to the status for anything else", async () => {
    expect(await msg("<html>", 502)).toBe("Request failed (502)");
    expect(await msg({ error: 5, error_description: "" }, 500)).toBe(
      "Request failed (500)",
    );
    expect(await msg(null, 500)).toBe("Request failed (500)");
  });
});

describe("fetchPlaces", () => {
  it("is a Worker call", async () => {
    const fetcher = vi.fn(
      async (_u: string, _i?: RequestInit) => new Response("{}"),
    );
    await fetchPlaces("search", "q=a", {}, {}, fetcher as never);
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://weather-api.mukoko.com/v1/search?q=a",
    );
  });
});

describe("no /api/py for the routes the Worker serves", () => {
  const files = [
    "src/lib/home-weather.ts",
    "src/lib/map-timeline.ts",
    "src/lib/icao-codes.ts",
    "src/lib/db.ts",
    "src/app/page.tsx",
    "src/app/locations/LocationsClient.tsx",
    "src/app/display/DisplayDashboard.tsx",
    "src/app/history/HistoryDashboard.tsx",
    "src/app/aviation/AviationPlanner.tsx",
    "src/app/api/embed/current/route.ts",
    "src/components/weather/AirQualityCard.tsx",
    "src/components/weather/AirQualityDetails.tsx",
    "src/components/weather/AtmosphericSummary.tsx",
    "src/components/weather/AgricultureHistory.tsx",
    "src/components/weather/HistoryAnalysis.tsx",
    "src/components/explore/ExploreSearch.tsx",
  ];
  const served =
    /["'`]\/api\/py\/(weather|airquality(?!\/grid)|search|geo|locations(?!\/profile)|history|explore|metar|airports)/;
  it.each(files)("%s", (file) => {
    const source = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !/^\s*\*/.test(line))
      .join("\n");
    expect(source).not.toMatch(served);
  });
});

describe("devices route", () => {
  it("is addressed on the Worker with the device id in the path", () => {
    expect(workerUrl("devices", "", {})).toBe(
      "https://weather-api.mukoko.com/v1/devices",
    );
    expect(workerUrl("devices/abc", "", {})).toBe(
      "https://weather-api.mukoko.com/v1/devices/abc",
    );
  });

  it("uses a configured safe origin, ignores an unsafe one", () => {
    expect(
      workerUrl("devices/abc", "", {
        NEXT_PUBLIC_WEATHER_API_URL: "https://worker.example.test/",
      }),
    ).toBe("https://worker.example.test/v1/devices/abc");
    expect(
      workerUrl("devices", "", {
        NEXT_PUBLIC_WEATHER_API_URL: "http://evil.example.test",
      }),
    ).toBe("https://weather-api.mukoko.com/v1/devices");
  });
});
