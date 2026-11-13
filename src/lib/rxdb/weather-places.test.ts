import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { WeatherData } from "../weather";
import type { DashboardPayload } from "../device-weather";
import type { WeatherPlaceDocType } from "./schemas";
import {
  type PlaceCollection,
  type PlaceDoc,
  _setPlaceCollectionSource,
  clearPlaces,
  listPlaces,
  placesUsage,
  readPlaces,
  recallPlace,
  rememberPlace,
  subscribePlaces,
} from "./weather-places";
import { weatherPlaceSchema } from "./schemas";
import { canonicalSlug } from "../slug-migration";
import { HOME_SNAPSHOT_KEY, rememberHomeSnapshot } from "../home-snapshot";

const HOUR = 3_600_000;
const OFFSET = 7200;
const harare = (day: number, h: number) =>
  Date.UTC(2026, 9, day, h) - OFFSET * 1000;

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

function payload(slug: string): DashboardPayload {
  return {
    location: {
      slug,
      name: slug,
      province: "P",
      lat: -17.8,
      lon: 31,
      elevation: 1490,
      tags: [],
      country: "ZW",
    },
    weather: weather(),
    usingFallback: false,
    frostAlert: null,
    season: { name: "Hot", localName: "Chirimo", description: "" },
    countryName: "Zimbabwe",
  };
}

/** In-memory stand-in for the RxDB collection. */
class FakeCollection implements PlaceCollection {
  docs = new Map<string, WeatherPlaceDocType>();
  failNextUpserts = 0;
  failWith: unknown = new DOMException("full", "QuotaExceededError");
  patched: Array<[string, Partial<WeatherPlaceDocType>]> = [];
  private wrap(d: WeatherPlaceDocType): PlaceDoc {
    return {
      ...d,
      incrementalPatch: async (p) => {
        this.patched.push([d.slug, p]);
        this.docs.set(d.slug, { ...this.docs.get(d.slug)!, ...p });
      },
    };
  }
  findOne(slug: string) {
    return {
      exec: async () => {
        const d = this.docs.get(slug);
        return d ? this.wrap(d) : null;
      },
    };
  }
  find() {
    return {
      exec: async () => [...this.docs.values()].map((d) => this.wrap(d)),
    };
  }
  async upsert(doc: WeatherPlaceDocType) {
    if (this.failNextUpserts > 0) {
      this.failNextUpserts -= 1;
      throw this.failWith;
    }
    this.docs.set(doc.slug, doc);
  }
  async bulkRemove(ids: string[]) {
    for (const id of ids) this.docs.delete(id);
  }
}

let col: FakeCollection;
beforeEach(() => {
  col = new FakeCollection();
  _setPlaceCollectionSource(async () => col);
});
afterEach(() => _setPlaceCollectionSource(null));

describe("weather_places schema", () => {
  it("is a new v0 collection keyed by slug (no migration needed)", () => {
    expect(weatherPlaceSchema.version).toBe(0);
    expect(weatherPlaceSchema.primaryKey).toBe("slug");
    expect(weatherPlaceSchema.required).toEqual(
      expect.arrayContaining([
        "payload",
        "fetchedAt",
        "lastAccessedAt",
        "expiresAt",
      ]),
    );
  });
});

describe("rememberPlace / recallPlace", () => {
  it("stores a payload and paints it back as current within the hour", async () => {
    const t = harare(11, 9);
    expect(await rememberPlace(payload("harare"), { now: t })).toBe(true);
    const doc = col.docs.get("harare")!;
    expect(doc.fetchedAt).toBe(t);
    expect(doc.expiresAt).toBe(harare(13, 0));
    const v = await recallPlace("harare", t + 30 * 60_000);
    expect(v?.freshness).toBe("current");
    // A shipped place is shown under its canonical slug (#317).
    expect(v?.payload.location.slug).toBe(canonicalSlug("harare"));
    // Showing a place refreshes its LRU timestamp.
    expect(col.patched).toEqual([
      ["harare", { lastAccessedAt: t + 30 * 60_000 }],
    ]);
  });

  it("finds a copy stored under a seed's legacy slug and shows it under the canonical one, whichever spelling asked (#317)", async () => {
    const t = harare(11, 9);
    await rememberPlace(payload("harare"), { now: t });
    const canonical = canonicalSlug("harare");
    expect(col.docs.has(canonical)).toBe(false);
    for (const asked of [canonical, "harare"]) {
      const v = await recallPlace(asked, t + 30 * 60_000);
      expect(v?.freshness, asked).toBe("current");
      // The place on screen is the canonical one, so its URL and its memory
      // entry are too (an in-place switch to a legacy link lands on the
      // canonical URL); the stored copy itself is left where it is.
      expect(v?.payload.location.slug, asked).toBe(canonical);
    }
    expect(col.docs.has("harare")).toBe(true);
  });

  it("a copy stored under the canonical slug is found by the legacy spelling, and wins over an older legacy copy", async () => {
    const t = harare(11, 9);
    const canonical = canonicalSlug("harare");
    await rememberPlace(payload("harare"), { now: t });
    await rememberPlace(payload(canonical), { now: t + 1000 });
    const v = await recallPlace("harare", t + 30 * 60_000);
    expect(v?.payload.location.slug).toBe(canonical);
    expect(v?.fetchedAt).toBe(t + 1000);
    // Only the canonical copy exists: the legacy spelling still finds it.
    col.docs.delete("harare");
    expect((await recallPlace("harare", t + 30 * 60_000))?.fetchedAt).toBe(
      t + 1000,
    );
  });

  it("a slug that is not in the pinned table is looked up as it always was", async () => {
    const t = harare(11, 9);
    await rememberPlace(payload("kakamega-ke"), { now: t });
    const v = await recallPlace("kakamega-ke", t + 30 * 60_000);
    expect(v?.payload.location.slug).toBe("kakamega-ke");
    expect(await recallPlace("kakamega--ksy4dd7")).toBeNull();
  });

  it("a legacy-keyed copy that is corrupt is deleted under its own key", async () => {
    col.docs.set("harare", {
      slug: "harare",
      payload: "{broken",
      fetchedAt: 1,
      lastAccessedAt: 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
      bytes: 7,
    });
    expect(await recallPlace(canonicalSlug("harare"))).toBeNull();
    expect(col.docs.has("harare")).toBe(false);
  });

  it("shows older data as this hour's forecast", async () => {
    const t = harare(11, 9);
    await rememberPlace(payload("harare"), { now: t });
    const v = await recallPlace("harare", harare(11, 15));
    expect(v?.freshness).toBe("forecast");
    expect(v?.payload.weather.hourly.time[0]).toBe("2026-10-11T15:00");
  });

  it("deletes an expired record instead of showing it", async () => {
    await rememberPlace(payload("harare"), { now: harare(11, 9) });
    expect(await recallPlace("harare", harare(13, 1))).toBeNull();
    expect(col.docs.has("harare")).toBe(false);
  });

  it("deletes a corrupted record instead of throwing", async () => {
    col.docs.set("harare", {
      slug: "harare",
      payload: "{broken",
      fetchedAt: 1,
      lastAccessedAt: 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
      bytes: 7,
    });
    expect(await recallPlace("harare")).toBeNull();
    expect(col.docs.has("harare")).toBe(false);
  });

  it("does not store the seasonal fallback", async () => {
    expect(
      await rememberPlace({ ...payload("harare"), usingFallback: true }),
    ).toBe(false);
    expect(col.docs.size).toBe(0);
  });

  it("on a quota error keeps only pinned places and retries once", async () => {
    const t = harare(11, 9);
    await rememberPlace(payload("old"), { now: t });
    await rememberPlace(payload("saved"), { now: t });
    col.failNextUpserts = 1;
    expect(
      await rememberPlace(payload("new"), { now: t + 1, pinned: ["saved"] }),
    ).toBe(true);
    expect([...col.docs.keys()].sort()).toEqual(["new", "saved"]);
  });

  it("gives up quietly when storage stays full", async () => {
    col.failNextUpserts = 2;
    expect(await rememberPlace(payload("harare"))).toBe(false);
  });

  it("gives up quietly on other write errors without evicting", async () => {
    await rememberPlace(payload("keep"), { now: harare(11, 9) });
    col.failNextUpserts = 1;
    col.failWith = new Error("disk I/O");
    expect(await rememberPlace(payload("new"), { now: harare(11, 9) })).toBe(
      false,
    );
    expect(col.docs.has("keep")).toBe(true);
  });

  it("evicts least-recently-used places past the count cap, sparing pinned ones", async () => {
    const t = harare(11, 9);
    for (let i = 0; i < 21; i++) {
      await rememberPlace(payload(`p${i}`), { now: t + i, pinned: ["p0"] });
    }
    expect(col.docs.size).toBe(20);
    expect(col.docs.has("p0")).toBe(true); // pinned
    expect(col.docs.has("p1")).toBe(false); // oldest unpinned
  });
});

describe("when storage is unavailable (SSR, private mode, Safari's 7-day wipe)", () => {
  it("reads empty and writes nothing", async () => {
    _setPlaceCollectionSource(async () => null);
    expect(await rememberPlace(payload("harare"))).toBe(false);
    expect(await recallPlace("harare")).toBeNull();
    expect(await listPlaces()).toEqual([]);
    expect(await placesUsage()).toEqual({ count: 0, bytes: 0 });
    expect(await clearPlaces()).toBe(0);
  });

  it("treats a throwing database as empty", async () => {
    _setPlaceCollectionSource(async () => {
      throw new Error("IndexedDB blocked");
    });
    expect(await recallPlace("harare")).toBeNull();
    expect(await rememberPlace(payload("harare"))).toBe(false);
  });

  it("the default source is null on the server", async () => {
    _setPlaceCollectionSource(null);
    expect(await recallPlace("harare")).toBeNull();
  });
});

describe("listPlaces / usage / clear", () => {
  it("lists usable places most recent first and drops broken ones", async () => {
    const t = harare(11, 9);
    await rememberPlace(payload("a"), { now: t });
    await rememberPlace(payload("b"), { now: t + 1000 });
    col.docs.set("broken", {
      ...col.docs.get("a")!,
      slug: "broken",
      payload: "x",
    });
    const list = await listPlaces(t + 2000);
    expect(list.map((p) => p.slug)).toEqual(["b", "a"]);
    expect(col.docs.has("broken")).toBe(false);
  });

  it("reports usage and clears everything", async () => {
    await rememberPlace(payload("a"), { now: harare(11, 9) });
    await rememberPlace(payload("b"), { now: harare(11, 9) });
    const u = await placesUsage();
    expect(u.count).toBe(2);
    expect(u.bytes).toBeGreaterThan(1000);
    expect(await clearPlaces()).toBe(2);
    expect(col.docs.size).toBe(0);
  });
});

describe("readPlaces (what the alerts read)", () => {
  it("returns the asked places in the order asked, skipping missing ones", async () => {
    const t = harare(11, 9);
    await rememberPlace(payload("a"), { now: t });
    await rememberPlace(payload("b"), { now: t });
    const read = await readPlaces(["b", "nope", "a", "b"], t + 1000);
    expect(read.map((p) => p.slug)).toEqual(["b", "a"]);
    expect(read[0].payload.location.slug).toBe("b");
    expect(read[0].fetchedAt).toBe(t);
  });

  it("is read-only: it does not touch the LRU timestamp or delete anything", async () => {
    const t = harare(11, 9);
    await rememberPlace(payload("a"), { now: t });
    col.docs.set("broken", {
      ...col.docs.get("a")!,
      slug: "broken",
      payload: "{",
    });
    col.patched.length = 0;
    const read = await readPlaces(["a", "broken"], t + 1000);
    expect(read.map((p) => p.slug)).toEqual(["a"]);
    expect(col.patched).toEqual([]);
    expect(col.docs.has("broken")).toBe(true);
    // Expired records are left alone too.
    expect(await readPlaces(["a"], harare(13, 1))).toEqual([]);
    expect(col.docs.has("a")).toBe(true);
  });

  it("finds a copy stored under the legacy slug and shows it under the canonical one", async () => {
    const t = harare(11, 9);
    const canonical = canonicalSlug("harare");
    // Stored before the move: under the legacy slug, with the legacy slug inside.
    await rememberPlace(payload("harare"), { now: t });
    expect(col.docs.has("harare")).toBe(true);
    for (const asked of ["harare", canonical]) {
      const read = await readPlaces([asked], t + 1000);
      expect(
        read.map((p) => p.slug),
        asked,
      ).toEqual([canonical]);
      expect(read[0].payload.location.slug).toBe(canonical);
    }
    // Asked by both spellings: one place.
    expect(
      (await readPlaces(["harare", canonical], t + 1000)).map((p) => p.slug),
    ).toEqual([canonical]);
  });

  it("reads empty for no slugs, and when storage is unavailable", async () => {
    expect(await readPlaces([])).toEqual([]);
    expect(await readPlaces(["", ""])).toEqual([]);
    _setPlaceCollectionSource(async () => null);
    expect(await readPlaces(["a"])).toEqual([]);
  });

  it("one unreadable place does not hide the others", async () => {
    const t = harare(11, 9);
    await rememberPlace(payload("a"), { now: t });
    await rememberPlace(payload("b"), { now: t });
    const real = col.findOne.bind(col);
    col.findOne = ((slug: string) =>
      slug === "a"
        ? { exec: async () => Promise.reject(new Error("boom")) }
        : real(slug)) as typeof col.findOne;
    expect((await readPlaces(["a", "b"], t + 1000)).map((p) => p.slug)).toEqual(
      ["b"],
    );
  });
});

describe("subscribePlaces (the bell looks again when a place is stored)", () => {
  it("is told after a place is stored and after the store is cleared, until it unsubscribes", async () => {
    let calls = 0;
    const off = subscribePlaces(() => {
      calls += 1;
    });
    await rememberPlace(payload("a"), { now: harare(11, 9) });
    expect(calls).toBe(1);
    await clearPlaces();
    expect(calls).toBe(2);
    off();
    await rememberPlace(payload("a"), { now: harare(11, 9) });
    expect(calls).toBe(2);
  });

  it("is not told when nothing was stored or cleared, and a throwing listener breaks nothing", async () => {
    let calls = 0;
    const off = subscribePlaces(() => {
      calls += 1;
    });
    const off2 = subscribePlaces(() => {
      throw new Error("listener bug");
    });
    expect(await clearPlaces()).toBe(0);
    await rememberPlace({ ...payload("a"), usingFallback: true });
    expect(calls).toBe(0);
    expect(await rememberPlace(payload("a"), { now: harare(11, 9) })).toBe(
      true,
    );
    expect(calls).toBe(1);
    off();
    off2();
  });
});

describe("the quick copy of My Location (home-snapshot.ts) follows the stored places", () => {
  const data = new Map<string, string>();
  beforeEach(() => {
    data.clear();
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const fetchedAtOfHeld = () =>
    data.has(HOME_SNAPSHOT_KEY)
      ? JSON.parse(data.get(HOME_SNAPSHOT_KEY)!).fetchedAt
      : null;

  it("is refreshed when the same place is stored again (a place page was opened), so it is never older than the stored copy", async () => {
    const t = harare(11, 9);
    rememberHomeSnapshot(payload("harare"), t, t);
    await rememberPlace(payload("harare"), { now: t + 10 * 60_000 });
    expect(fetchedAtOfHeld()).toBe(t + 10 * 60_000);
  });

  it("is never made by storing a place, and another place's copy is left alone", async () => {
    const t = harare(11, 9);
    await rememberPlace(payload("harare"), { now: t });
    expect(data.has(HOME_SNAPSHOT_KEY)).toBe(false);
    rememberHomeSnapshot(payload("harare"), t, t);
    await rememberPlace(payload("bulawayo"), { now: t + 60_000 });
    expect(JSON.parse(data.get(HOME_SNAPSHOT_KEY)!).slug).toBe(
      canonicalSlug("harare"),
    );
  });

  it("goes when the stored places are cleared", async () => {
    const t = harare(11, 9);
    await rememberPlace(payload("harare"), { now: t });
    rememberHomeSnapshot(payload("harare"), t, t);
    expect(data.has(HOME_SNAPSHOT_KEY)).toBe(true);
    await clearPlaces();
    expect(data.has(HOME_SNAPSHOT_KEY)).toBe(false);
  });
});
