/**
 * Behaviour of `detectUserLocation` with a stubbed browser and network: what
 * it asks, which backend answers, and how the Worker's flags come back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectUserLocation } from "./geolocation";

function stubGps(lat: number, lon: number) {
  vi.stubGlobal("navigator", {
    geolocation: {
      getCurrentPosition: (ok: (p: unknown) => void) =>
        ok({ coords: { latitude: lat, longitude: lon } }),
    },
  });
}

const seed = {
  slug: "harare",
  name: "Harare",
  province: "Harare",
  lat: -17.83,
  lon: 31.05,
  elevation: 1490,
  tags: ["city"],
};

function answer(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_WEATHER_API_URL", "https://weather-api.test");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("detectUserLocation", () => {
  it("asks the Worker first, with the exact fix and no create flag", async () => {
    stubGps(-17.83, 31.05);
    const fetcher = vi.fn(async (_url: string) =>
      answer({ nearest: seed, isNew: false }),
    );
    vi.stubGlobal("fetch", fetcher);
    const r = await detectUserLocation();
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://weather-api.test/v1/geo?lat=-17.83&lon=31.05",
    );
    expect(r.status).toBe("success");
    expect(r.location?.slug).toBe("harare");
    expect(r.distanceKm).toBe(0);
  });

  it("adds autoCreate when asked to create", async () => {
    stubGps(1, 2);
    const fetcher = vi.fn(async (_url: string) =>
      answer({ nearest: seed, isNew: true }),
    );
    vi.stubGlobal("fetch", fetcher);
    const r = await detectUserLocation({ autoCreate: true });
    expect(String(fetcher.mock.calls[0][0])).toContain("&autoCreate=true");
    expect(r.status).toBe("created");
    expect(r.isNew).toBe(true);
  });

  it("retries the Worker once on a 5xx (never /api/py)", async () => {
    stubGps(1, 2);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(answer({}, 503))
      .mockResolvedValueOnce(answer({ nearest: seed }));
    vi.stubGlobal("fetch", fetcher);
    const r = await detectUserLocation();
    expect(String(fetcher.mock.calls[1][0])).toContain("/v1/geo?lat=1&lon=2");
    expect(r.location?.slug).toBe("harare");
  });

  it("uses the production Worker when no override is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_WEATHER_API_URL", "");
    stubGps(1, 2);
    const fetcher = vi.fn(async (_url: string) => answer({ nearest: seed }));
    vi.stubGlobal("fetch", fetcher);
    await detectUserLocation();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://weather-api.mukoko.com/v1/geo?lat=1&lon=2",
    );
  });

  it("reports a definitive nothing as unnamed, not as skipped", async () => {
    stubGps(0, -30);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        answer({
          nearest: {
            ...seed,
            slug: "0-00n-30-00w--7zzzzzz",
            lat: 0,
            lon: -30,
            named: false,
          },
          synthesized: true,
        }),
      ),
    );
    const r = await detectUserLocation();
    expect(r.synthesized).toBe(true);
    expect(r.unnamed).toBe(true);
    expect(r.namingSkipped).toBe(false);
  });

  it("reports a skipped naming as skipped, not as unnamed", async () => {
    stubGps(0, -30);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        answer({
          nearest: {
            ...seed,
            slug: "x--y",
            lat: 0,
            lon: -30,
            namingSkipped: true,
          },
          synthesized: true,
        }),
      ),
    );
    const r = await detectUserLocation();
    expect(r.namingSkipped).toBe(true);
    expect(r.unnamed).toBe(false);
  });

  it("is an error when both backends fail", async () => {
    stubGps(1, 2);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer({}, 500)),
    );
    const r = await detectUserLocation();
    expect(r.status).toBe("error");
    expect(r.coords).toEqual({ lat: 1, lon: 2 });
  });

  it("reports denial without any request", async () => {
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: (_ok: unknown, err: (e: unknown) => void) =>
          err({ code: 1, PERMISSION_DENIED: 1 }),
      },
    });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect((await detectUserLocation()).status).toBe("denied");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
