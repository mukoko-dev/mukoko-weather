import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  weatherCacheKey,
  WEATHER_CACHE_GRID_DEG,
  WEATHER_CACHE_KEY_PREFIX,
} from "./weather-cache-key";

// ---------------------------------------------------------------------------
// Issue #252: weather_cache rows are keyed by coordinate grid cell. These
// vectors are shared with tests/py/test_weather_cache_key.py, so the TS SSR
// reader and the Python writer can never derive different keys.
// ---------------------------------------------------------------------------

const findOne = vi.fn();
vi.mock("./mongo", () => {
  const db = () => ({ collection: () => ({ findOne }) });
  return {
    weatherDb: db,
    placesDb: db,
    identityDb: db,
    shamwariDb: db,
    platformDb: db,
    entityDb: db,
  };
});

interface Fixture {
  gridDeg: number;
  vectors: { lat: number; lon: number; key: string }[];
}

const fixture = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../tests/fixtures/weather-cache-keys.json"),
    "utf-8",
  ),
) as Fixture;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin((r(lat2) - r(lat1)) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

describe("weatherCacheKey", () => {
  it("matches the shared Python vectors exactly", () => {
    expect(fixture.gridDeg).toBe(WEATHER_CACHE_GRID_DEG);
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(10);
    for (const v of fixture.vectors) {
      expect(weatherCacheKey(v.lat, v.lon)).toBe(v.key);
    }
  });

  it("gives far-apart coordinates different rows", () => {
    // The production mismatches from #252.
    expect(weatherCacheKey(24.86, 67.01)).not.toBe(
      weatherCacheKey(11.28, 49.18),
    ); // Karachi vs Bosaso
    expect(weatherCacheKey(50.1112, 8.6831)).not.toBe(
      weatherCacheKey(37.29042, 9.855),
    ); // Frankfurt vs Bizerte

    // Deterministic sweep: beyond one cell diagonal, keys always differ.
    const maxCellKm = haversineKm(
      0,
      0,
      WEATHER_CACHE_GRID_DEG,
      WEATHER_CACHE_GRID_DEG,
    );
    let seed = 252;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 5000; i++) {
      const a = [rand() * 178 - 89, rand() * 359.8 - 179.9] as const;
      const b = [rand() * 178 - 89, rand() * 359.8 - 179.9] as const;
      if (haversineKm(a[0], a[1], b[0], b[1]) > maxCellKm) {
        expect(weatherCacheKey(a[0], a[1])).not.toBe(
          weatherCacheKey(b[0], b[1]),
        );
      }
    }
  });

  it("gives nearby requests in one cell the same row", () => {
    const keys = new Set([
      weatherCacheKey(-17.8292, 31.0522),
      weatherCacheKey(-17.83, 31.05),
      weatherCacheKey(-17.835, 31.06),
      weatherCacheKey(-17.84, 31.04),
    ]);
    expect([...keys]).toEqual(["cell:-17.85_31.05"]);
  });

  it("never collides with a legacy place-slug or raw-coordinate key", () => {
    const key = weatherCacheKey(-17.83, 31.05);
    expect(key.startsWith(WEATHER_CACHE_KEY_PREFIX)).toBe(true);
    expect(/^[a-z0-9-]{1,80}$/.test(key)).toBe(false);
    expect(key).not.toBe("-17.83_31.05");
  });

  it("folds the antimeridian and avoids negative zero", () => {
    expect(weatherCacheKey(10, 180)).toBe(weatherCacheKey(10, -180));
    expect(weatherCacheKey(-0.01, -0.01)).toBe("cell:0.00_0.00");
  });
});

describe("getWeatherForLocation reads the key the Python writer writes", () => {
  beforeEach(() => {
    findOne.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("looks up the row by the coordinate cell, not the page slug", async () => {
    const cached = { current: { temperature_2m: 21 } };
    findOne.mockResolvedValue({ data: cached });
    const { getWeatherForLocation } = await import("./db");

    const res = await getWeatherForLocation("harare", -17.8292, 31.0522, 1490);

    expect(res).toEqual({ data: cached, source: "cache" });
    const filter = findOne.mock.calls[0][0];
    expect(filter.locationSlug).toBe("cell:-17.85_31.05");
    expect(filter.locationSlug).toBe(weatherCacheKey(-17.8292, 31.0522));
    expect(filter.expiresAt.$gt).toBeInstanceOf(Date);
  });

  it("on a miss, asks Python for the same coordinates it keyed the read on", async () => {
    findOne.mockResolvedValue(null);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ current: {} }), {
        status: 200,
        headers: { "x-weather-provider": "open-meteo" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getWeatherForLocation } = await import("./db");

    await getWeatherForLocation("karachi-pk", 24.86, 67.01, 10);

    expect(findOne.mock.calls[0][0].locationSlug).toBe("cell:24.85_67.00");
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    // Python derives its write key from these exact values.
    expect(
      weatherCacheKey(
        Number(url.searchParams.get("lat")),
        Number(url.searchParams.get("lon")),
      ),
    ).toBe("cell:24.85_67.00");
  });
});
