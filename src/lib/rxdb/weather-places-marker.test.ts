import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WeatherData } from "../weather";
import type { DashboardPayload } from "../device-weather";
import type { WeatherPlaceDocType } from "./schemas";
import { _resetPlacesMarker, PLACES_MARKER_KEY } from "./places-marker";
import {
  _setPlaceCollectionSource,
  clearPlaces,
  listPlaces,
  placesUsage,
  readPlaces,
  recallPlace,
  rememberPlace,
} from "./weather-places";
import { _resetStartGate } from "./start-gate";

// The stored-places readers and the first-visit skip (issue 551): through the
// REAL collection source (`defaultCollection`), whose database is replaced here
// by a spy, so what is asserted is whether the database was opened.

const getDatabase = vi.fn();
vi.mock("./database", () => ({ getDatabase: () => getDatabase() }));

const HOUR = 3_600_000;
const OFFSET = 7200;

function weather(): WeatherData {
  const time = Array.from({ length: 48 }, (_, i) =>
    new Date(Date.UTC(2026, 9, 11) + i * HOUR).toISOString().slice(0, 16),
  );
  const s = (v: number) => time.map(() => v);
  return {
    current: {
      temperature_2m: 20,
      relative_humidity_2m: 40,
      apparent_temperature: 19,
      precipitation: 0,
      weather_code: 1,
      cloud_cover: 10,
      wind_speed_10m: 5,
      wind_direction_10m: 90,
      wind_gusts_10m: 9,
      uv_index: 4,
      surface_pressure: 860,
      is_day: 1,
    },
    hourly: {
      time,
      temperature_2m: s(18),
      apparent_temperature: s(17),
      relative_humidity_2m: s(40),
      precipitation_probability: s(0),
      precipitation: s(0),
      weather_code: s(1),
      visibility: s(20000),
      cloud_cover: s(10),
      surface_pressure: s(860),
      wind_speed_10m: s(5),
      wind_direction_10m: s(90),
      wind_gusts_10m: s(9),
      uv_index: s(2),
      is_day: s(1),
    },
    daily: {
      time: ["2026-10-11", "2026-10-12"],
      weather_code: [1, 1],
      temperature_2m_max: [27, 28],
      temperature_2m_min: [11, 12],
      apparent_temperature_max: [27, 28],
      apparent_temperature_min: [10, 11],
      sunrise: ["2026-10-11T05:40", "2026-10-12T05:39"],
      sunset: ["2026-10-11T18:10", "2026-10-12T18:10"],
      uv_index_max: [9, 9],
      precipitation_sum: [0, 0],
      precipitation_probability_max: [0, 0],
      wind_speed_10m_max: [20, 20],
    } as WeatherData["daily"],
    current_units: {},
    utc_offset_seconds: OFFSET,
  } as WeatherData;
}

const SLUG = "west-paddock--ksy4dd7";
const payload = (): DashboardPayload =>
  ({
    location: {
      slug: SLUG,
      name: "West Paddock",
      lat: -17.8,
      lon: 31.0,
      elevation: 1490,
      country: "ZW",
      province: "Harare",
      tags: [],
    },
    weather: weather(),
    season: { name: "Rainy", localName: "Zhizha" },
    usingFallback: false,
  }) as unknown as DashboardPayload;

/** A one-collection fake of what RxDB hands back, holding what was upserted. */
function fakeDb() {
  const docs = new Map<string, WeatherPlaceDocType>();
  const order: string[] = [];
  const weather_places = {
    findOne: (slug: string) => ({
      exec: async () => docs.get(slug) ?? null,
    }),
    find: () => ({
      exec: async () => [...docs.values()],
    }),
    upsert: async (doc: WeatherPlaceDocType) => {
      order.push(`upsert:${localStorage.getItem(PLACES_MARKER_KEY)}`);
      docs.set(doc.slug, doc);
    },
    bulkRemove: async (slugs: string[]) => {
      for (const slug of slugs) docs.delete(slug);
    },
  };
  return { db: { weather_places }, docs, order };
}

function stubBrowser(
  marker: string | null,
  databases: Array<{ name?: string }> | undefined,
) {
  const data = new Map<string, string>();
  if (marker !== null) data.set(PLACES_MARKER_KEY, marker);
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
  });
  vi.stubGlobal(
    "indexedDB",
    databases ? { databases: async () => databases } : {},
  );
  return data;
}

beforeEach(() => {
  getDatabase.mockReset();
  _resetPlacesMarker();
  _resetStartGate();
  _setPlaceCollectionSource(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
  _setPlaceCollectionSource(null);
});

describe("a first visit: nothing stored, so the database is not opened to ask", () => {
  it("recallPlace answers nothing and never asks for the database", async () => {
    const data = stubBrowser(null, []);
    expect(await recallPlace(SLUG)).toBeNull();
    expect(getDatabase).not.toHaveBeenCalled();
    expect(data.get(PLACES_MARKER_KEY)).toBe("0");
  });

  it("every other reader of stored places is just as quiet", async () => {
    stubBrowser("0", []);
    expect(await listPlaces()).toEqual([]);
    expect(await readPlaces([SLUG])).toEqual([]);
    expect(await placesUsage()).toEqual({ count: 0, bytes: 0 });
    expect(await clearPlaces()).toBe(0);
    expect(getDatabase).not.toHaveBeenCalled();
  });
});

describe("a visit with anything stored behaves exactly as before", () => {
  it("marker 1: recallPlace opens the database and finds the stored place", async () => {
    stubBrowser("1", []);
    const fake = fakeDb();
    getDatabase.mockResolvedValue(fake.db);
    await rememberPlace(payload(), { now: Date.UTC(2026, 9, 12, 8) });
    getDatabase.mockClear();
    const view = await recallPlace(SLUG, Date.UTC(2026, 9, 12, 9));
    expect(getDatabase).toHaveBeenCalledTimes(1);
    expect(view?.payload.location.slug).toBe(SLUG);
  });

  it("a device from before the marker (a database, no marker) opens it and keeps the marker", async () => {
    const data = stubBrowser(null, [
      { name: "rxdb-dexie-mukoko_weather--0--weather_places" },
    ]);
    const fake = fakeDb();
    getDatabase.mockResolvedValue(fake.db);
    await recallPlace(SLUG);
    expect(getDatabase).toHaveBeenCalledTimes(1);
    expect(data.get(PLACES_MARKER_KEY)).toBe("1");
  });

  it("a browser that cannot list databases opens it, as before", async () => {
    stubBrowser(null, undefined);
    getDatabase.mockResolvedValue(fakeDb().db);
    await recallPlace(SLUG);
    expect(getDatabase).toHaveBeenCalledTimes(1);
  });

  it("a test's own collection source is always asked", async () => {
    stubBrowser("0", []);
    const fake = fakeDb();
    _setPlaceCollectionSource(async () => fake.db.weather_places);
    await recallPlace(SLUG);
    expect(getDatabase).not.toHaveBeenCalled();
    // the source answered (it found nothing, which is its answer)
    expect(await listPlaces()).toEqual([]);
  });
});

describe("storing the first place, and clearing", () => {
  it("rememberPlace opens the database to write, and marks it BEFORE the write", async () => {
    const data = stubBrowser(null, []);
    const fake = fakeDb();
    getDatabase.mockResolvedValue(fake.db);
    expect(await recallPlace(SLUG)).toBeNull();
    expect(data.get(PLACES_MARKER_KEY)).toBe("0");
    expect(getDatabase).not.toHaveBeenCalled();

    expect(
      await rememberPlace(payload(), { now: Date.UTC(2026, 9, 12, 8) }),
    ).toBe(true);
    expect(fake.order).toEqual(["upsert:1"]);
    expect(data.get(PLACES_MARKER_KEY)).toBe("1");

    // and from then on this page reads the database
    getDatabase.mockClear();
    const view = await recallPlace(SLUG, Date.UTC(2026, 9, 12, 9));
    expect(getDatabase).toHaveBeenCalledTimes(1);
    expect(view?.payload.location.slug).toBe(SLUG);
  });

  it("clearPlaces empties the store and the next visit does not open the database", async () => {
    const data = stubBrowser("1", []);
    const fake = fakeDb();
    getDatabase.mockResolvedValue(fake.db);
    await rememberPlace(payload(), { now: Date.UTC(2026, 9, 12, 8) });
    expect(await clearPlaces()).toBe(1);
    expect(fake.docs.size).toBe(0);
    expect(data.get(PLACES_MARKER_KEY)).toBe("0");

    // a new page load after it
    _resetPlacesMarker();
    getDatabase.mockClear();
    expect(await recallPlace(SLUG)).toBeNull();
    expect(getDatabase).not.toHaveBeenCalled();
  });

  it("clearing storage that left the database behind falls back to the check by name", async () => {
    const data = stubBrowser("1", [
      { name: "rxdb-dexie-mukoko_weather--0--x" },
    ]);
    data.clear();
    getDatabase.mockResolvedValue(fakeDb().db);
    await recallPlace(SLUG);
    expect(getDatabase).toHaveBeenCalledTimes(1);
    expect(data.get(PLACES_MARKER_KEY)).toBe("1");
  });

  it("a write that is refused as too big still leaves the marker on 1 (it is a superset, never behind)", async () => {
    const data = stubBrowser(null, []);
    const fake = fakeDb();
    fake.db.weather_places.upsert = async () => {
      throw new Error("nope");
    };
    getDatabase.mockResolvedValue(fake.db);
    await rememberPlace(payload(), { now: Date.UTC(2026, 9, 12, 8) });
    expect(data.get(PLACES_MARKER_KEY)).toBe("1");
  });
});
