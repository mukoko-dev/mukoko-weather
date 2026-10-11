import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_KEY_HEADER,
  PUBLIC_FORECAST_URL,
  configuredForecastBase,
  openMeteoForecastUrl,
  openMeteoHeaders,
} from "./open-meteo-endpoint";

const SELF = {
  OPEN_METEO_BASE_URL: "https://om.example.com",
  OPEN_METEO_API_KEY: "k-test",
};

describe("openMeteoForecastUrl", () => {
  it("defaults to the public API", () => {
    expect(openMeteoForecastUrl({})).toBe(PUBLIC_FORECAST_URL);
    expect(openMeteoForecastUrl(null)).toBe(PUBLIC_FORECAST_URL);
  });

  it("appends /v1/forecast to a configured base and drops a trailing slash", () => {
    expect(
      openMeteoForecastUrl({ OPEN_METEO_BASE_URL: "https://om.example.com/" }),
    ).toBe("https://om.example.com/v1/forecast");
  });

  it("accepts a value that already names the endpoint, and a path prefix", () => {
    expect(
      openMeteoForecastUrl({
        OPEN_METEO_BASE_URL: "https://om.example.com/v1/forecast",
      }),
    ).toBe("https://om.example.com/v1/forecast");
    expect(
      openMeteoForecastUrl({
        OPEN_METEO_BASE_URL: "https://edge.example.com/om",
      }),
    ).toBe("https://edge.example.com/om/v1/forecast");
  });

  it("allows http only for localhost", () => {
    expect(
      openMeteoForecastUrl({ OPEN_METEO_BASE_URL: "http://localhost:8081" }),
    ).toBe("http://localhost:8081/v1/forecast");
  });

  it.each([
    "http://om.example.com",
    "om.example.com",
    "ftp://om.example.com",
    "https://user:pass@om.example.com",
    "https://om.example.com/?apikey=x",
    "   ",
  ])("falls back to the public API for %s", (value) => {
    expect(configuredForecastBase({ OPEN_METEO_BASE_URL: value })).toBeNull();
    expect(openMeteoForecastUrl({ OPEN_METEO_BASE_URL: value })).toBe(
      PUBLIC_FORECAST_URL,
    );
  });
});

describe("openMeteoHeaders", () => {
  it("never sends the key to the public API", () => {
    expect(
      openMeteoHeaders(PUBLIC_FORECAST_URL, { OPEN_METEO_API_KEY: "k-test" }),
    ).toEqual({});
  });

  it("sends the key in the default header to the self-hosted instance", () => {
    const url = openMeteoForecastUrl(SELF);
    expect(openMeteoHeaders(url, SELF)).toEqual({
      [DEFAULT_KEY_HEADER]: "k-test",
    });
  });

  it("honours a custom header name and rejects an invalid one", () => {
    const url = openMeteoForecastUrl(SELF);
    expect(
      openMeteoHeaders(url, {
        ...SELF,
        OPEN_METEO_API_KEY_HEADER: "X-Weather-Key",
      }),
    ).toEqual({
      "X-Weather-Key": "k-test",
    });
    expect(
      openMeteoHeaders(url, {
        ...SELF,
        OPEN_METEO_API_KEY_HEADER: "bad header:",
      }),
    ).toEqual({
      [DEFAULT_KEY_HEADER]: "k-test",
    });
  });

  it("sends nothing when no key is set", () => {
    const env = { OPEN_METEO_BASE_URL: "https://om.example.com" };
    expect(openMeteoHeaders(openMeteoForecastUrl(env), env)).toEqual({});
  });
});

describe("server-only env", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reads process.env on the server", () => {
    vi.stubEnv("OPEN_METEO_BASE_URL", "https://om.example.com");
    expect(openMeteoForecastUrl()).toBe("https://om.example.com/v1/forecast");
  });

  it("ignores the env in a browser, so the key never ships to the client", () => {
    vi.stubEnv("OPEN_METEO_BASE_URL", "https://om.example.com");
    vi.stubEnv("OPEN_METEO_API_KEY", "k-test");
    vi.stubGlobal("window", {});
    const url = openMeteoForecastUrl();
    expect(url).toBe(PUBLIC_FORECAST_URL);
    expect(openMeteoHeaders(url)).toEqual({});
  });
});

describe("fetchWeather wiring", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function capture(): Promise<{ url: string; init: RequestInit }> {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        current: {},
        hourly: { time: [] },
        daily: { time: [] },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { fetchWeather } = await import("./weather");
    await fetchWeather(-17.83, 31.05).catch(() => undefined);
    const [url, init] = fetchMock.mock.calls[0];
    return { url: String(url), init };
  }

  it("calls the public API with no key header by default", async () => {
    vi.stubEnv("OPEN_METEO_BASE_URL", "");
    const { url, init } = await capture();
    expect(url.startsWith(`${PUBLIC_FORECAST_URL}?`)).toBe(true);
    expect(init.headers).toEqual({});
  });

  it("calls the self-hosted instance with the key header when configured", async () => {
    vi.stubEnv("OPEN_METEO_BASE_URL", "https://om.example.com");
    vi.stubEnv("OPEN_METEO_API_KEY", "k-test");
    const { url, init } = await capture();
    expect(url.startsWith("https://om.example.com/v1/forecast?")).toBe(true);
    expect(init.headers).toEqual({ [DEFAULT_KEY_HEADER]: "k-test" });
  });
});
