import { describe, expect, it, vi } from "vitest";
import {
  fetchPlaces,
  legacyPlacesUrl,
  weatherApiBase,
  workerPlacesUrl,
} from "./weather-api";

const ON = { NEXT_PUBLIC_WEATHER_API_URL: "https://weather-api.mukoko.com/" };

describe("weatherApiBase", () => {
  it("is off when unset or blank", () => {
    expect(weatherApiBase({})).toBeNull();
    expect(weatherApiBase({ NEXT_PUBLIC_WEATHER_API_URL: "  " })).toBeNull();
  });

  it("returns a bare https origin", () => {
    expect(weatherApiBase(ON)).toBe("https://weather-api.mukoko.com");
  });

  it("allows plain http only for localhost", () => {
    expect(
      weatherApiBase({ NEXT_PUBLIC_WEATHER_API_URL: "http://localhost:8787" }),
    ).toBe("http://localhost:8787");
    expect(
      weatherApiBase({ NEXT_PUBLIC_WEATHER_API_URL: "http://weather.test" }),
    ).toBeNull();
  });

  it.each([
    "not a url",
    "https://user:pw@weather.test",
    "https://weather.test/?x=1",
    "https://weather.test/#x",
    "ftp://weather.test",
  ])("rejects %s", (url) => {
    expect(weatherApiBase({ NEXT_PUBLIC_WEATHER_API_URL: url })).toBeNull();
  });
});

describe("places URLs", () => {
  it("builds the Worker URL, or null while off", () => {
    expect(workerPlacesUrl("geo", "lat=1&lon=2", ON)).toBe(
      "https://weather-api.mukoko.com/v1/geo?lat=1&lon=2",
    );
    expect(workerPlacesUrl("geo", "lat=1&lon=2", {})).toBeNull();
  });

  it("keeps the frozen Python route as the fallback", () => {
    expect(legacyPlacesUrl("search", "q=a")).toBe("/api/py/search?q=a");
  });
});

describe("fetchPlaces", () => {
  const res = (status: number) => new Response("{}", { status });

  it("uses only /api/py while the switch is off", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      res(200),
    );
    await fetchPlaces("geo", "lat=1&lon=2", {}, {}, fetcher as never);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("/api/py/geo?lat=1&lon=2");
  });

  it("answers from the Worker when it is on and healthy", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      res(200),
    );
    await fetchPlaces("geo", "lat=1&lon=2", {}, ON, fetcher as never);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain(
      "weather-api.mukoko.com/v1/geo",
    );
  });

  it("treats a 4xx as the answer, not a reason to fall back", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      res(404),
    );
    const out = await fetchPlaces("geo", "x=1", {}, ON, fetcher as never);
    expect(out.status).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([500, 502, 503])("falls back to /api/py on a %i", async (status) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(res(status))
      .mockResolvedValueOnce(res(200));
    const out = await fetchPlaces("geo", "x=1", {}, ON, fetcher as never);
    expect(out.status).toBe(200);
    expect(fetcher.mock.calls[1][0]).toBe("/api/py/geo?x=1");
  });

  it("falls back when the Worker is unreachable", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(res(200));
    expect(
      (await fetchPlaces("search", "q=a", {}, ON, fetcher as never)).status,
    ).toBe(200);
  });

  it("does not retry an aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi
      .fn()
      .mockRejectedValue(new DOMException("aborted", "AbortError"));
    await expect(
      fetchPlaces(
        "geo",
        "x=1",
        { signal: controller.signal },
        ON,
        fetcher as never,
      ),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
