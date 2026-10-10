import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// No database in tests: the cache read throws and SSR moves on to the
// internal endpoint, which is what these tests exercise (issue #262).
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

import { getWeatherForLocation, internalWeatherFailure } from "./db";

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

const ENV_KEYS = [
  "INTERNAL_API_BASE_URL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
] as const;

describe("getWeatherForLocation self-fetch (issue #262)", () => {
  const saved: Record<string, string | undefined> = {};
  let fetchMock: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("production calls the public origin, never the protected deployment host", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.VERCEL_URL = "mukoko-weather-abc-nyuchi.vercel.app";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "weather.mukoko.com";
    fetchMock.mockResolvedValueOnce(
      json(PY_PAYLOAD, { "x-weather-provider": "model-blend" }),
    );

    const result = await getWeatherForLocation("harare", -17.83, 31.05, 1490);

    expect(result.source).toBe("model-blend");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(
      /^https:\/\/weather\.mukoko\.com\/api\/py\/weather\?lat=-17\.83&lon=31\.05&location=harare$/,
    );
    expect(init.redirect).toBe("manual");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("a preview sends the bypass header to its own host", async () => {
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_URL = "mukoko-weather-abc-nyuchi.vercel.app";
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "s3cret";
    fetchMock.mockResolvedValueOnce(json(PY_PAYLOAD));

    await getWeatherForLocation("harare", -17.83, 31.05, 1490);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(
      "https://mukoko-weather-abc-nyuchi.vercel.app/api/py/weather",
    );
    expect(init.headers).toEqual({ "x-vercel-protection-bypass": "s3cret" });
  });

  it("reports a protection redirect as a redirect, never leaking the secret", async () => {
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_URL = "mukoko-weather-abc-nyuchi.vercel.app";
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "s3cret";
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://vercel.com/sso-api?url=x" },
        }),
      )
      // direct Open-Meteo fallback
      .mockResolvedValueOnce(json(PY_PAYLOAD));

    const result = await getWeatherForLocation("harare", -17.83, 31.05, 1490);

    expect(result.source).toBe("open-meteo");
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged.message).toContain("redirected (302)");
    expect(logged.meta.status).toBe(302);
    expect(logged.meta.bypassHeader).toBe(true);
    expect(JSON.stringify(logged)).not.toContain("s3cret");
  });

  it("does not try to parse an HTML 200 (the old login-page trap)", async () => {
    process.env.VERCEL_ENV = "production";
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
    expect(logged.message).toContain("non-JSON (text/html");
    expect(logged.meta.host).toBe("weather.mukoko.com");
  });

  it("logs the real network error when the endpoint is unreachable", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(json(PY_PAYLOAD));

    await getWeatherForLocation("harare", -17.83, 31.05, 1490);

    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged.message).toContain("unreachable");
    expect(logged.errorName).toBe("TypeError");
    expect(logged.errorMessage).toBe("fetch failed");
    expect(logged.meta.host).toBe("localhost:3000");
  });
});

describe("internalWeatherFailure", () => {
  it("names redirects, non-JSON successes and error statuses", () => {
    expect(internalWeatherFailure(307, "")).toContain("redirected (307)");
    expect(internalWeatherFailure(200, "text/html")).toContain(
      "non-JSON (text/html)",
    );
    expect(internalWeatherFailure(200, "")).toContain("no content-type");
    expect(internalWeatherFailure(502, "text/plain")).toBe(
      "Internal weather endpoint returned 502, falling back to direct Open-Meteo",
    );
  });
});
