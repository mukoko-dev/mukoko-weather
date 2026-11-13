import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WeatherData } from "./weather";
import type { DashboardPayload } from "./device-weather";
import { REFRESH_AFTER_MS } from "./device-weather";
import {
  forgetHomeSnapshot,
  HOME_SNAPSHOT_KEY,
  HOME_SNAPSHOT_MAX_BYTES,
  HOME_SNAPSHOT_VERSION,
  recallHomeSnapshot,
  rememberHomeSnapshot,
} from "./home-snapshot";
import { canonicalSlug } from "./slug-migration";

const HOUR = 3_600_000;
const OFFSET = 7200; // Harare, UTC+2

/** Naive local "YYYY-MM-DDTHH:00" strings from 2026-10-11T00:00 local. */
function hours(n: number): string[] {
  const start = Date.UTC(2026, 9, 11, 0, 0);
  return Array.from({ length: n }, (_, i) =>
    new Date(start + i * HOUR).toISOString().slice(0, 16),
  );
}

/** 2026-10-12 10:00 in Harare: inside the fixture's 168-hour forecast. */
const NOW = Date.UTC(2026, 9, 12, 10, 0) - OFFSET * 1000;

function weather(): WeatherData {
  const time = hours(168);
  const series = (f: (i: number) => number) => time.map((_, i) => f(i));
  return {
    current: {
      temperature_2m: 21,
      relative_humidity_2m: 50,
      apparent_temperature: 20,
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
      temperature_2m: series((i) => 10 + (i % 12)),
      apparent_temperature: series(() => 9),
      relative_humidity_2m: series(() => 40),
      precipitation_probability: series(() => 10),
      precipitation: series(() => 0),
      weather_code: series(() => 1),
      visibility: series(() => 20000),
      cloud_cover: series(() => 30),
      surface_pressure: series(() => 861),
      wind_speed_10m: series(() => 7),
      wind_direction_10m: series(() => 180),
      wind_gusts_10m: series(() => 14),
      uv_index: series(() => 1),
      is_day: series(() => 1),
    },
    daily: {
      time: Array.from({ length: 7 }, (_, d) => `2026-10-${11 + d}`),
      weather_code: Array(7).fill(1),
      temperature_2m_max: Array(7).fill(25),
      temperature_2m_min: Array(7).fill(10),
      apparent_temperature_max: Array(7).fill(25),
      apparent_temperature_min: Array(7).fill(9),
      sunrise: Array(7).fill("2026-10-11T05:40"),
      sunset: Array(7).fill("2026-10-11T18:10"),
      uv_index_max: Array(7).fill(9),
      precipitation_sum: Array(7).fill(0),
      precipitation_probability_max: Array(7).fill(5),
      wind_speed_10m_max: Array(7).fill(20),
    } as WeatherData["daily"],
    current_units: {},
    utc_offset_seconds: OFFSET,
    minutely: { time: ["2026-10-12T09:00"], precipitation: [0] },
    models: [],
    models_available: ["ecmwf_ifs"],
    models_time: hours(3),
  } as WeatherData;
}

function payload(overrides: Partial<DashboardPayload> = {}): DashboardPayload {
  return {
    location: {
      slug: "west-paddock--ksy4dd7",
      name: "West Paddock",
      province: "Harare",
      lat: -17.83,
      lon: 31.05,
      elevation: 1490,
      tags: ["spot"],
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

/** An in-memory localStorage on globalThis (what safe-storage reads). */
function stubStorage() {
  const data = new Map<string, string>();
  const calls = { set: 0 };
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      calls.set++;
      data.set(k, String(v));
    },
    removeItem: (k: string) => void data.delete(k),
  });
  return { data, calls };
}

let storage: ReturnType<typeof stubStorage>;

beforeEach(() => {
  storage = stubStorage();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const SLUG = "west-paddock--ksy4dd7";

describe("keeping the last forecast for My Location", () => {
  it("keeps one place under one key, in the slim form the device store uses", () => {
    expect(rememberHomeSnapshot(payload(), NOW, NOW)).toBe(true);
    expect([...storage.data.keys()]).toEqual([HOME_SNAPSHOT_KEY]);
    const stored = JSON.parse(storage.data.get(HOME_SNAPSHOT_KEY)!);
    expect(stored.v).toBe(HOME_SNAPSHOT_VERSION);
    expect(stored.slug).toBe(SLUG);
    expect(stored.fetchedAt).toBe(NOW);
    // The comparison series and the nowcast are large and stale within minutes.
    const inner = JSON.parse(stored.payload);
    expect(inner.weather.models).toBeUndefined();
    expect(inner.weather.minutely).toBeUndefined();
    expect(inner.location.slug).toBe(SLUG);
  });

  it("replaces the previous place: there is never more than one copy", () => {
    rememberHomeSnapshot(payload(), NOW, NOW);
    const other = payload({
      location: { ...payload().location, slug: "nairobi-ke", name: "Nairobi" },
    });
    rememberHomeSnapshot(other, NOW, NOW);
    expect([...storage.data.keys()]).toEqual([HOME_SNAPSHOT_KEY]);
    expect(recallHomeSnapshot(SLUG, NOW)).toBeNull();
    expect(recallHomeSnapshot("nairobi-ke", NOW)?.payload.location.name).toBe(
      "Nairobi",
    );
  });

  it("never keeps the seasonal estimate or weather that would not render", () => {
    expect(rememberHomeSnapshot(payload({ usingFallback: true }), NOW)).toBe(
      false,
    );
    const bad = payload();
    (bad.weather as unknown as { hourly: unknown }).hourly = null;
    expect(rememberHomeSnapshot(bad, NOW)).toBe(false);
    expect(storage.data.size).toBe(0);
  });

  it("does not keep a copy over the size limit, and drops the old place's copy rather than leave it as this one's", () => {
    rememberHomeSnapshot(payload(), NOW, NOW);
    expect(storage.data.size).toBe(1);
    const big = payload();
    // A long place name pushes it over; it still serialises for IndexedDB.
    big.location = {
      ...big.location,
      name: "x".repeat(HOME_SNAPSHOT_MAX_BYTES),
    };
    expect(rememberHomeSnapshot(big, NOW + 1000, NOW + 1000)).toBe(false);
    expect(storage.data.size).toBe(0);
  });

  it("never replaces a newer copy of the same place (another tab kept one) with an older one", () => {
    rememberHomeSnapshot(payload(), NOW, NOW);
    expect(rememberHomeSnapshot(payload(), NOW - 30 * 60_000, NOW)).toBe(true);
    expect(JSON.parse(storage.data.get(HOME_SNAPSHOT_KEY)!).fetchedAt).toBe(
      NOW,
    );
    // A newer one does replace it.
    rememberHomeSnapshot(payload(), NOW + 60_000, NOW + 60_000);
    expect(JSON.parse(storage.data.get(HOME_SNAPSHOT_KEY)!).fetchedAt).toBe(
      NOW + 60_000,
    );
  });

  it("does not write a forecast that is already held, so showing a copy read back from the device costs no write", () => {
    rememberHomeSnapshot(payload(), NOW, NOW);
    rememberHomeSnapshot(payload(), NOW, NOW);
    expect(storage.calls.set).toBe(1);
    const view = recallHomeSnapshot(SLUG, NOW)!;
    rememberHomeSnapshot(view.payload, view.fetchedAt, NOW);
    expect(storage.calls.set).toBe(1);
  });

  it("writes it again when something else removed it (another tab, the visitor, the browser)", () => {
    rememberHomeSnapshot(payload(), NOW, NOW);
    storage.data.delete(HOME_SNAPSHOT_KEY);
    expect(rememberHomeSnapshot(payload(), NOW, NOW)).toBe(true);
    expect(storage.data.has(HOME_SNAPSHOT_KEY)).toBe(true);
    expect(storage.calls.set).toBe(2);
  });

  it("with onlyIfHeld, brings a held copy of that place up to date and never makes one", () => {
    // Nothing held: nothing is made.
    expect(
      rememberHomeSnapshot(payload(), NOW, NOW, { onlyIfHeld: true }),
    ).toBe(false);
    expect(storage.data.size).toBe(0);
    // Held for this place: a newer forecast refreshes it.
    rememberHomeSnapshot(payload(), NOW - 60_000, NOW);
    expect(
      rememberHomeSnapshot(payload(), NOW, NOW, { onlyIfHeld: true }),
    ).toBe(true);
    expect(JSON.parse(storage.data.get(HOME_SNAPSHOT_KEY)!).fetchedAt).toBe(
      NOW,
    );
    // Held for another place: left alone.
    const other = payload({
      location: { ...payload().location, slug: "nairobi-ke", name: "Nairobi" },
    });
    expect(rememberHomeSnapshot(other, NOW, NOW, { onlyIfHeld: true })).toBe(
      false,
    );
    expect(JSON.parse(storage.data.get(HOME_SNAPSHOT_KEY)!).slug).toBe(SLUG);
  });

  it("removes the old copy when the new one cannot be written, rather than leave it as the last word", () => {
    rememberHomeSnapshot(payload(), NOW - 60_000, NOW);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storage.data.get(k) ?? null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: (k: string) => void storage.data.delete(k),
    });
    expect(rememberHomeSnapshot(payload(), NOW, NOW)).toBe(false);
    expect(storage.data.has(HOME_SNAPSHOT_KEY)).toBe(false);
  });

  it("keeps the age of a forecast the Worker served stale, not the moment it was received", () => {
    const stale = payload();
    (stale.weather as unknown as { baseline: unknown }).baseline = {
      stale: true,
      ageSeconds: 600,
    };
    rememberHomeSnapshot(stale, undefined, NOW);
    const stored = JSON.parse(storage.data.get(HOME_SNAPSHOT_KEY)!);
    expect(stored.fetchedAt).toBe(NOW - 600_000);
  });

  it("never throws where storage is blocked or full", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(rememberHomeSnapshot(payload(), NOW, NOW)).toBe(false);
    expect(recallHomeSnapshot(SLUG, NOW)).toBeNull();
    expect(() => forgetHomeSnapshot()).not.toThrow();
  });
});

describe("reading it back", () => {
  it("returns the place ready to render, with the age it had", () => {
    rememberHomeSnapshot(payload(), NOW - 5 * 60_000, NOW);
    const view = recallHomeSnapshot(SLUG, NOW)!;
    expect(view.payload.location.name).toBe("West Paddock");
    expect(view.payload.weather.current.temperature_2m).toBe(21);
    expect(view.fetchedAt).toBe(NOW - 5 * 60_000);
    expect(view.freshness).toBe("current");
    expect(view.payload.usingFallback).toBe(false);
  });

  it("re-bases the forecast on now, as the device store does", () => {
    rememberHomeSnapshot(payload(), NOW - 5 * 60_000, NOW);
    const later = NOW + 3 * HOUR;
    const view = recallHomeSnapshot(SLUG, later)!;
    // Hours that have passed are gone from the front of the series.
    expect(view.payload.weather.hourly.time[0]).toBe("2026-10-12T13:00");
    expect(view.freshness).toBe("forecast");
  });

  it("is found by either spelling of a shipped place", () => {
    const harare = payload({
      location: {
        ...payload().location,
        slug: canonicalSlug("harare"),
        name: "Harare",
      },
    });
    rememberHomeSnapshot(harare, NOW, NOW);
    expect(recallHomeSnapshot("harare", NOW)?.payload.location.name).toBe(
      "Harare",
    );
    expect(
      recallHomeSnapshot(canonicalSlug("harare"), NOW)?.payload.location.name,
    ).toBe("Harare");
  });

  it("returns nothing for another place, and keeps the copy it has", () => {
    rememberHomeSnapshot(payload(), NOW, NOW);
    expect(recallHomeSnapshot("nairobi-ke", NOW)).toBeNull();
    expect(storage.data.has(HOME_SNAPSHOT_KEY)).toBe(true);
    expect(recallHomeSnapshot("", NOW)).toBeNull();
  });

  it("returns nothing, and removes the copy, when its forecast has run out", () => {
    rememberHomeSnapshot(payload(), NOW, NOW);
    const muchLater = NOW + 10 * 24 * HOUR;
    expect(recallHomeSnapshot(SLUG, muchLater)).toBeNull();
    expect(storage.data.has(HOME_SNAPSHOT_KEY)).toBe(false);
  });

  it("drops a copy that is corrupt, from an older shape, or hand-edited", () => {
    for (const raw of [
      "{not json",
      "null",
      JSON.stringify({ v: 99, slug: SLUG, fetchedAt: NOW, payload: "{}" }),
      JSON.stringify({ v: HOME_SNAPSHOT_VERSION, slug: SLUG, payload: "{}" }),
      JSON.stringify({
        v: HOME_SNAPSHOT_VERSION,
        slug: SLUG,
        fetchedAt: NOW,
        payload: "{}",
      }),
      JSON.stringify({
        v: HOME_SNAPSHOT_VERSION,
        slug: SLUG,
        fetchedAt: NOW,
        payload: 42,
      }),
    ]) {
      storage.data.set(HOME_SNAPSHOT_KEY, raw);
      expect(recallHomeSnapshot(SLUG, NOW)).toBeNull();
      expect(storage.data.has(HOME_SNAPSHOT_KEY)).toBe(false);
    }
  });

  it("is a view the controller treats like any stored copy (fresh enough, or to refresh)", () => {
    rememberHomeSnapshot(payload(), NOW - 5 * 60_000, NOW);
    const fresh = recallHomeSnapshot(SLUG, NOW)!;
    expect(NOW - fresh.fetchedAt).toBeLessThanOrEqual(REFRESH_AFTER_MS);
  });
});

describe("it stays on this device (the owner's rule: nothing personal in the service worker, a CDN or the HTML)", () => {
  const read = (file: string) =>
    readFileSync(resolve(__dirname, file), "utf-8");

  it("is never read by the server's pages, the edge proxy, the service worker or the layout", () => {
    for (const file of [
      "../app/page.tsx",
      "../app/layout.tsx",
      "../app/[location]/page.tsx",
      "../proxy.ts",
      "../app/sw.ts",
      "sw-navigation.ts",
      "sw-shell.ts",
      "sw-precache.ts",
    ]) {
      expect(read(file), file).not.toContain("home-snapshot");
    }
  });

  it("only reads and writes this device's localStorage: no network, no cookie, no cache, no beacon", () => {
    const code = read("home-snapshot.ts")
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    for (const forbidden of [
      /\bfetch\s*\(/,
      /XMLHttpRequest/,
      /sendBeacon/,
      /document\.cookie/,
      /\bcaches\b/,
      /serviceWorker/,
      /indexedDB/,
      /from ["']next\//,
    ]) {
      expect(code).not.toMatch(forbidden);
    }
    // The only way in or out of storage is safe-storage.
    expect(code).toMatch(/from "\.\/safe-storage"/);
    expect(code).not.toMatch(/localStorage\./);
  });

  it("is written only by the home page's hook and the device store, and read by the place stage and the home page", () => {
    expect(read("use-home-snapshot.ts")).toContain("rememberHomeSnapshot");
    expect(read("rxdb/weather-places.ts")).toContain("rememberHomeSnapshot");
    expect(read("rxdb/weather-places.ts")).toContain("forgetHomeSnapshot");
    expect(read("../components/weather/PlaceStage.tsx")).toContain(
      "recallHomeSnapshot",
    );
    expect(read("../app/CurrentLocationHome.tsx")).toContain(
      "recallHomeSnapshot",
    );
  });
});
