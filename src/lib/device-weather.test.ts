import { describe, it, expect } from "vitest";
import type { WeatherData } from "./weather";
import {
  CURRENT_MAX_AGE_MS,
  MAX_ENTRY_BYTES,
  type DashboardPayload,
  type StoredPlaceMeta,
  deviceViewOf,
  forecastCoversNow,
  forecastEndsAt,
  freshnessOf,
  isQuotaError,
  parsePayload,
  placeClockLabel,
  planEviction,
  rebaseWeather,
  serialisePayload,
  slimPayload,
  updatedAgoLabel,
} from "./device-weather";

const HOUR = 3_600_000;
const OFFSET = 7200; // Harare, UTC+2

/** Naive local "YYYY-MM-DDTHH:00" strings from 2026-10-11T00:00 local. */
function hours(n: number): string[] {
  const start = Date.UTC(2026, 9, 11, 0, 0); // wall clock as ms-if-UTC
  return Array.from({ length: n }, (_, i) =>
    new Date(start + i * HOUR).toISOString().slice(0, 16),
  );
}

/** Epoch ms for a Harare wall-clock time on 2026-10-DD HH:MM. */
function harare(day: number, h: number, m = 0): number {
  return Date.UTC(2026, 9, day, h, m) - OFFSET * 1000;
}

function weather(nHours = 168): WeatherData {
  const time = hours(nHours);
  const series = (f: (i: number) => number) => time.map((_, i) => f(i));
  const days = Math.ceil(nHours / 24);
  return {
    current: {
      temperature_2m: 99,
      relative_humidity_2m: 50,
      apparent_temperature: 98,
      precipitation: 0,
      weather_code: 0,
      cloud_cover: 0,
      wind_speed_10m: 5,
      wind_direction_10m: 90,
      wind_gusts_10m: 10,
      uv_index: 3,
      surface_pressure: 860,
      is_day: 1,
    },
    hourly: {
      time,
      temperature_2m: series((i) => i), // temp = hour index, easy to assert
      apparent_temperature: series((i) => i - 1),
      relative_humidity_2m: series(() => 40),
      precipitation_probability: series(() => 10),
      precipitation: series(() => 0),
      weather_code: series((i) => (i % 2 ? 3 : 61)),
      visibility: series(() => 20000),
      cloud_cover: series(() => 30),
      surface_pressure: series(() => 861),
      wind_speed_10m: series(() => 7),
      wind_direction_10m: series(() => 180),
      wind_gusts_10m: series(() => 14),
      uv_index: series(() => 1),
      is_day: series(() => 0),
    },
    daily: {
      time: Array.from({ length: days }, (_, d) => `2026-10-${11 + d}`),
      weather_code: Array(days).fill(1),
      temperature_2m_max: Array.from({ length: days }, (_, d) => 25 + d),
      temperature_2m_min: Array(days).fill(10),
      apparent_temperature_max: Array(days).fill(25),
      apparent_temperature_min: Array(days).fill(9),
      sunrise: Array(days).fill("2026-10-11T05:40"),
      sunset: Array(days).fill("2026-10-11T18:10"),
      uv_index_max: Array(days).fill(9),
      precipitation_sum: Array(days).fill(0),
      precipitation_probability_max: Array(days).fill(5),
      wind_speed_10m_max: Array(days).fill(20),
    } as WeatherData["daily"],
    current_units: {},
    utc_offset_seconds: OFFSET,
    minutely: { time: ["2026-10-11T09:00"], precipitation: [0] },
    models: [],
    models_available: ["ecmwf_ifs"],
    models_time: hours(3),
  } as WeatherData;
}

function payload(overrides: Partial<DashboardPayload> = {}): DashboardPayload {
  return {
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
    weather: weather(),
    usingFallback: false,
    frostAlert: null,
    season: { name: "Hot dry", localName: "Chirimo", description: "" },
    countryName: "Zimbabwe",
    ...overrides,
  };
}

describe("serialisePayload / parsePayload", () => {
  it("round-trips a payload without the comparison series or nowcast", () => {
    const s = serialisePayload(payload());
    expect(s).not.toBeNull();
    const back = parsePayload(s!.json)!;
    expect(back.location.slug).toBe("harare");
    expect(back.weather.models).toBeUndefined();
    expect(back.weather.minutely).toBeUndefined();
    expect(back.weather.hourly.time).toHaveLength(168);
    expect(s!.bytes).toBe(s!.json.length);
  });

  it("never stores the seasonal fallback", () => {
    expect(serialisePayload(payload({ usingFallback: true }))).toBeNull();
  });

  it("refuses weather that would not render", () => {
    const bad = payload();
    (bad.weather as unknown as { hourly: unknown }).hourly = null;
    expect(serialisePayload(bad)).toBeNull();
  });

  it("refuses an over-large payload", () => {
    const big = payload();
    big.location = { ...big.location, name: "x".repeat(MAX_ENTRY_BYTES) };
    expect(serialisePayload(big)).toBeNull();
  });

  it("returns null for corrupted records instead of throwing", () => {
    expect(parsePayload("{not json")).toBeNull();
    expect(parsePayload(42)).toBeNull();
    expect(parsePayload("null")).toBeNull();
    expect(
      parsePayload(JSON.stringify({ location: { slug: "x" } })),
    ).toBeNull();
    const noSeason = JSON.stringify({
      ...slimPayload(payload()),
      season: null,
    });
    expect(parsePayload(noSeason)).toBeNull();
    const noWeather = JSON.stringify({
      ...payload(),
      weather: { current: {} },
    });
    expect(parsePayload(noWeather)).toBeNull();
  });
});

describe("forecast horizon", () => {
  it("ends one hour after the last hourly slot, in the place's time", () => {
    // Last slot is local 2026-10-17T23:00 → ends 2026-10-18T00:00 local.
    expect(forecastEndsAt(weather())).toBe(harare(18, 0));
  });

  it("covers now until the series runs out", () => {
    const w = weather(24);
    expect(forecastCoversNow(w, harare(11, 23, 59))).toBe(true);
    expect(forecastCoversNow(w, harare(12, 0))).toBe(false);
  });

  it("has no horizon for an empty series", () => {
    const w = weather(0);
    expect(forecastEndsAt(w)).toBeNull();
    expect(forecastCoversNow(w)).toBe(false);
  });
});

describe("freshnessOf", () => {
  const fetchedAt = harare(11, 9);
  it("is current up to the 60-minute limit", () => {
    expect(
      freshnessOf(fetchedAt, weather(), fetchedAt + CURRENT_MAX_AGE_MS),
    ).toBe("current");
  });
  it("falls back to the forecast hour after that", () => {
    expect(
      freshnessOf(fetchedAt, weather(), fetchedAt + CURRENT_MAX_AGE_MS + 1),
    ).toBe("forecast");
  });
  it("is not shown at all once the forecast has run out", () => {
    expect(freshnessOf(fetchedAt, weather(24), harare(12, 1))).toBeNull();
  });
  it("never calls a future or corrupt timestamp current", () => {
    expect(freshnessOf(fetchedAt + 10 * HOUR, weather(), fetchedAt)).toBe(
      "forecast",
    );
    expect(freshnessOf(Number.NaN, weather(), fetchedAt)).toBe("forecast");
  });
});

describe("rebaseWeather", () => {
  it("starts hourly at the place's current hour and daily at its today", () => {
    // 2026-10-12 14:30 in Harare — index 24 + 14 = 38.
    const r = rebaseWeather(weather(), "current", harare(12, 14, 30));
    expect(r.hourly.time[0]).toBe("2026-10-12T14:00");
    expect(r.hourly.temperature_2m[0]).toBe(38);
    expect(r.daily.time[0]).toBe("2026-10-12");
    expect(r.daily.temperature_2m_max[0]).toBe(26);
    expect(r.current.temperature_2m).toBe(99); // current kept as stored
    expect(r.minutely).toBeUndefined();
  });

  it("rebuilds current from the forecast hour for a forecast view", () => {
    const r = rebaseWeather(weather(), "forecast", harare(12, 14, 30));
    expect(r.current.temperature_2m).toBe(38);
    expect(r.current.apparent_temperature).toBe(37);
    expect(r.current.weather_code).toBe(61);
    expect(r.current.surface_pressure).toBe(861);
  });

  it("reads 'now' in the location's zone, not the viewer's", () => {
    // 23:30 UTC on the 11th is already 01:30 on the 12th in Harare.
    const r = rebaseWeather(
      weather(),
      "forecast",
      Date.UTC(2026, 9, 11, 23, 30),
    );
    expect(r.hourly.time[0]).toBe("2026-10-12T01:00");
    expect(r.daily.time[0]).toBe("2026-10-12");
  });

  it("keeps the stored value when the forecast hour has a gap", () => {
    const w = weather();
    (w.hourly.uv_index as unknown as (number | null)[])[38] = null;
    const r = rebaseWeather(w, "forecast", harare(12, 14));
    expect(r.current.uv_index).toBe(3);
  });

  it("does not mutate the stored payload", () => {
    const w = weather();
    rebaseWeather(w, "forecast", harare(13, 5));
    expect(w.hourly.time).toHaveLength(168);
    expect(w.current.temperature_2m).toBe(99);
    expect(w.minutely).toBeDefined();
  });
});

describe("deviceViewOf", () => {
  it("returns a rebased view with frost recomputed", () => {
    const v = deviceViewOf(
      { payload: payload(), fetchedAt: harare(11, 9) },
      harare(11, 9, 20),
    );
    expect(v?.freshness).toBe("current");
    expect(v?.payload.weather.hourly.time[0]).toBe("2026-10-11T09:00");
    // Hourly temps 9..30 are above frost; no alert.
    expect(v?.payload.frostAlert).toBeNull();
  });

  it("is null when the forecast no longer covers now", () => {
    expect(
      deviceViewOf(
        { payload: payload(), fetchedAt: harare(11, 9) },
        harare(19, 0),
      ),
    ).toBeNull();
  });
});

describe("labels", () => {
  const t = harare(11, 9);
  it("says how old the data is", () => {
    expect(updatedAgoLabel(t, t + 20_000)).toBe("Updated just now");
    expect(updatedAgoLabel(t, t + 12 * 60_000)).toBe("Updated 12 min ago");
    expect(updatedAgoLabel(t, t + 3 * HOUR)).toBe("Updated 3 h ago");
    expect(updatedAgoLabel(t, t + 72 * HOUR)).toBe("Updated 3 days ago");
    expect(updatedAgoLabel(t + 5000, t)).toBe("Updated just now");
  });
  it("shows the place's own clock", () => {
    expect(placeClockLabel(weather(), harare(11, 21, 7))).toBe("21:07");
  });
});

describe("planEviction", () => {
  const now = harare(11, 12);
  const meta = (
    slug: string,
    lastAccessedAt: number,
    extra: Partial<StoredPlaceMeta> = {},
  ): StoredPlaceMeta => ({
    slug,
    fetchedAt: lastAccessedAt,
    lastAccessedAt,
    expiresAt: now + 24 * HOUR,
    bytes: 10_000,
    ...extra,
  });

  it("always drops expired places, pinned or not", () => {
    const out = planEviction(
      [meta("a", now, { expiresAt: now - 1 }), meta("b", now)],
      new Set(["a"]),
      now,
    );
    expect(out).toEqual(["a"]);
  });

  it("drops a record with a corrupt expiry", () => {
    expect(
      planEviction([meta("a", now, { expiresAt: Number.NaN })], new Set(), now),
    ).toEqual(["a"]);
  });

  it("evicts least-recently-used unpinned places over the count cap", () => {
    const entries = [
      meta("old", 1),
      meta("mid", 2),
      meta("new", 3),
      meta("saved", 0),
    ];
    const out = planEviction(entries, new Set(["saved"]), now, {
      maxPlaces: 2,
      maxBytes: 1e9,
    });
    expect(out.sort()).toEqual(["mid", "old"]);
  });

  it("evicts until the byte budget fits", () => {
    const entries = [
      meta("a", 1, { bytes: 600 }),
      meta("b", 2, { bytes: 600 }),
    ];
    expect(
      planEviction(entries, new Set(), now, { maxPlaces: 10, maxBytes: 700 }),
    ).toEqual(["a"]);
  });

  it("never evicts pinned places for space", () => {
    const entries = [meta("a", 1), meta("b", 2)];
    expect(
      planEviction(entries, new Set(["a", "b"]), now, {
        maxPlaces: 0,
        maxBytes: 0,
      }),
    ).toEqual([]);
  });

  it("keeps everything inside the default budget", () => {
    const entries = Array.from({ length: 20 }, (_, i) => meta(`p${i}`, i));
    expect(planEviction(entries, new Set(), now)).toEqual([]);
    expect(planEviction([...entries, meta("p20", 99)], new Set(), now)).toEqual(
      ["p0"],
    );
  });
});

describe("isQuotaError", () => {
  it("recognises quota errors from IndexedDB, Dexie and RxDB", () => {
    expect(isQuotaError(new DOMException("full", "QuotaExceededError"))).toBe(
      true,
    );
    expect(
      isQuotaError({ name: "Error", message: "Dexie: QuotaExceeded" }),
    ).toBe(true);
    expect(isQuotaError(new Error("network down"))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });
});
