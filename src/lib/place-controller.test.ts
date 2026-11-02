import { beforeEach, describe, expect, it } from "vitest";
import type { WeatherData } from "./weather";
import type { DeviceView } from "./device-weather";
import { REFRESH_AFTER_MS, deviceViewOf } from "./device-weather";
import {
  MEMORY_MAX_PLACES,
  SLOW_LOAD_AFTER_MS,
  clearPlaceMemory,
  createPlaceController,
  isFreshEnough,
  liveViewFor,
  mergeStoredWithSeed,
  recallFromMemory,
  rememberInMemory,
  seedOfPayload,
  type PlaceDeps,
  type PlaceSeed,
  type PlaceState,
} from "./place-controller";

const HOUR = 3_600_000;
const OFFSET = 7200;

/** Naive local "YYYY-MM-DDTHH:00" strings from 2026-10-11T00:00 local. */
function hours(n: number): string[] {
  const start = Date.UTC(2026, 9, 11, 0, 0);
  return Array.from({ length: n }, (_, i) =>
    new Date(start + i * HOUR).toISOString().slice(0, 16),
  );
}

/** 2026-10-12 10:00 in Harare: inside the fixture's 168-hour forecast. */
const NOW = Date.UTC(2026, 9, 12, 10, 0) - OFFSET * 1000;

function weather(temp: number, extra: Partial<WeatherData> = {}): WeatherData {
  const time = hours(168);
  const series = (f: (i: number) => number) => time.map((_, i) => f(i));
  const days = 7;
  return {
    current: {
      temperature_2m: temp,
      relative_humidity_2m: 50,
      apparent_temperature: temp,
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
      temperature_2m: series(() => temp),
      apparent_temperature: series(() => temp),
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
      time: Array.from({ length: days }, (_, d) => `2026-10-${11 + d}`),
      weather_code: Array(days).fill(1),
      temperature_2m_max: Array(days).fill(25),
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
    timezone: "Africa/Harare",
    elevation: 1490,
    ...extra,
  } as WeatherData;
}

const SEASON = { name: "Hot dry", localName: "Chirimo", description: "" };

function seed(slug: string, lat: number, country = "ZW"): PlaceSeed {
  return {
    location: {
      slug,
      name: slug,
      province: "",
      lat,
      lon: 31,
      elevation: 1000,
      tags: ["city"],
      country,
    },
    season: SEASON,
    countryName: country === "ZW" ? "Zimbabwe" : "Kenya",
  };
}

const HARARE = seed("harare", -17.8);
const NAIROBI = seed("nairobi-ke", -1.3, "KE");
const LAGOS = seed("lagos-ng", 6, "NG");

interface Harness {
  deps: PlaceDeps;
  calls: {
    fetch: string[];
    recall: string[];
    resolve: string[];
    push: string[];
    replace: string[];
    shown: string[];
  };
  clock: { now: number };
  stored: Map<string, DeviceView>;
  /** Make fetchWeather wait until released; returns the release function. */
  hold(slug: string): () => void;
  failFetch: { on: boolean };
  /**
   * Run every scheduled RETRY timer now (live-fetch's 2 s, 5 s, 15 s); the
   * delays asked for, in order. The "still trying" clock is not a retry: it is
   * left alone here, and fired with fireSlow().
   */
  runTimers(): Promise<number[]>;
  /** Run the "still trying" clock now (SLOW_LOAD_AFTER_MS); how many ran. */
  fireSlow(): Promise<number>;
  /** The delays of every timer still waiting (cancelled ones are gone). */
  pending(): number[];
  fallbackAnswer: { on: boolean };
  path: { current: string };
  places: Map<string, PlaceSeed>;
}

function harness(initialPath: string): Harness {
  const calls: Harness["calls"] = {
    fetch: [],
    recall: [],
    resolve: [],
    push: [],
    replace: [],
    shown: [],
  };
  const clock = { now: NOW };
  const stored = new Map<string, DeviceView>();
  const holds = new Map<string, Promise<void>>();
  const failFetch = { on: false };
  const fallbackAnswer = { on: false };
  const path = { current: initialPath };
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const places = new Map<string, PlaceSeed>([
    ["harare", HARARE],
    ["nairobi-ke", NAIROBI],
    ["lagos-ng", LAGOS],
  ]);
  const byLat = new Map(
    [HARARE, NAIROBI, LAGOS].map((s) => [s.location.lat, s.location.slug]),
  );
  /** Remove the cancelled timers, and return (and remove) those `wanted`. */
  const take = (wanted: (t: (typeof timers)[number]) => boolean) => {
    for (let i = timers.length - 1; i >= 0; i--) {
      if (timers[i].cancelled) timers.splice(i, 1);
    }
    const due = timers.filter(wanted);
    for (const t of due) timers.splice(timers.indexOf(t), 1);
    return due;
  };
  const deps: PlaceDeps = {
    now: () => clock.now,
    recall: async (slug) => {
      calls.recall.push(slug);
      return stored.get(slug) ?? null;
    },
    fetchWeather: async (lat) => {
      const slug = byLat.get(lat) ?? "?";
      calls.fetch.push(slug);
      await holds.get(slug);
      if (failFetch.on) throw new Error("offline");
      return {
        weather: weather(Math.round(lat)),
        usingFallback: fallbackAnswer.on,
      };
    },
    resolve: async (slug) => {
      calls.resolve.push(slug);
      return places.get(slug) ?? null;
    },
    history: {
      path: () => path.current,
      push: (p) => {
        calls.push.push(p);
        path.current = p;
      },
      replace: (p) => {
        calls.replace.push(p);
        path.current = p;
      },
    },
    onShow: ({ seed: s, url }) => calls.shown.push(`${s.location.slug}:${url}`),
    recallTimeoutMs: 30,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  return {
    deps,
    calls,
    clock,
    stored,
    failFetch,
    fallbackAnswer,
    path,
    places,
    async runTimers() {
      const due = take((t) => t.ms !== SLOW_LOAD_AFTER_MS);
      for (const t of due) t.fn();
      await new Promise((r) => setTimeout(r, 5));
      return due.map((t) => t.ms);
    },
    async fireSlow() {
      const due = take((t) => t.ms === SLOW_LOAD_AFTER_MS);
      for (const t of due) t.fn();
      await new Promise((r) => setTimeout(r, 5));
      return due.length;
    },
    pending() {
      take(() => false);
      return timers.map((t) => t.ms);
    },
    hold(slug) {
      let release!: () => void;
      holds.set(
        slug,
        new Promise<void>((r) => {
          release = r;
        }),
      );
      return release;
    },
  };
}

function storedView(s: PlaceSeed, temp: number, ageMs: number): DeviceView {
  const fetchedAt = NOW - ageMs;
  const view = deviceViewOf(
    {
      payload: {
        ...seedOfPayload({
          location: s.location,
          weather: weather(temp),
          usingFallback: false,
          frostAlert: null,
          season: s.season,
          countryName: s.countryName,
        }),
        weather: weather(temp),
        usingFallback: false,
        frostAlert: null,
      },
      fetchedAt,
    },
    NOW,
  );
  if (!view) throw new Error("fixture not viewable");
  return view;
}

const temp = (state: PlaceState) => state.view?.weather.current.temperature_2m;

beforeEach(() => clearPlaceMemory());

describe("start: the server's place, then the device, then the visitor's own request", () => {
  it("fetches once for a place with nothing stored, then shows the live forecast", async () => {
    const h = harness("/harare");
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    expect(c.getState().view).toBeNull();
    expect(c.getState().seed?.location.slug).toBe("harare");

    const states: PlaceState[] = [];
    c.subscribe(() => states.push(c.getState()));
    const result = await c.start();

    expect(result).toEqual({ shown: true, failed: false });
    expect(h.calls.fetch).toEqual(["harare"]);
    expect(temp(c.getState())).toBe(-18);
    expect(c.getState().device).toBeNull();
    // The skeleton state (no view) was visible while the request was in flight.
    expect(states.some((s) => s.fetching && s.view === null)).toBe(true);
    // The URL is already right: no push or replace for the first place.
    expect(h.calls.push).toEqual([]);
    expect(h.calls.replace).toEqual([]);
  });

  it("paints a fresh device copy and makes NO request", async () => {
    const h = harness("/harare");
    h.stored.set("harare", storedView(HARARE, 21, 5 * 60_000));
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    expect(h.calls.fetch).toEqual([]);
    expect(temp(c.getState())).toBe(21);
    expect(c.getState().device?.freshness).toBe("current");
  });

  it("paints an old device copy at once and replaces it with the live forecast", async () => {
    const h = harness("/harare");
    h.stored.set("harare", storedView(HARARE, 21, REFRESH_AFTER_MS + 60_000));
    const release = h.hold("harare");
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    const done = c.start();
    await new Promise((r) => setTimeout(r, 5));
    // The device copy is on screen while the request is still in flight.
    expect(temp(c.getState())).toBe(21);
    expect(c.getState().device).not.toBeNull();
    expect(c.getState().fetching).toBe(true);
    release();
    await done;
    expect(temp(c.getState())).toBe(-18);
    expect(c.getState().device).toBeNull();
  });

  it("does not wait on a device that never answers", async () => {
    const h = harness("/harare");
    h.deps.recall = () => new Promise(() => {});
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    expect(h.calls.fetch).toEqual(["harare"]);
    expect(temp(c.getState())).toBe(-18);
  });

  it("uses a slow device's copy when it arrives before the forecast does", async () => {
    const h = harness("/harare");
    h.stored.set("harare", storedView(HARARE, 21, REFRESH_AFTER_MS + 60_000));
    // The database is slow to open (its code loads on first use).
    h.deps.recall = (slug) =>
      new Promise((resolve) =>
        setTimeout(() => resolve(h.stored.get(slug) ?? null), 80),
      );
    h.failFetch.on = true; // and the network is down
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    const done = c.start();
    await done; // the fetch failed fast; the device is still thinking
    expect(c.getState().view).toBeNull();
    await new Promise((r) => setTimeout(r, 120));
    expect(temp(c.getState())).toBe(21);
    expect(c.getState().device).not.toBeNull();
    for (let i = 0; i < 3; i++) await h.runTimers();
    expect(c.getState().failed).toBe(true);
  });

  it("ignores a slow device's copy once the live forecast is on screen", async () => {
    const h = harness("/harare");
    h.stored.set("harare", storedView(HARARE, 21, REFRESH_AFTER_MS + 60_000));
    h.deps.recall = (slug) =>
      new Promise((resolve) =>
        setTimeout(() => resolve(h.stored.get(slug) ?? null), 80),
      );
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    expect(temp(c.getState())).toBe(-18);
    await new Promise((r) => setTimeout(r, 120));
    expect(temp(c.getState())).toBe(-18);
    expect(c.getState().device).toBeNull();
  });

  it("keeps the server's season and location on top of a stored copy", async () => {
    const h = harness("/harare");
    const old = storedView(HARARE, 21, 5 * 60_000);
    old.payload = {
      ...old.payload,
      season: { name: "Old", localName: "Old", description: "" },
    };
    h.stored.set("harare", old);
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    expect(c.getState().view?.season.name).toBe("Hot dry");
  });
});

describe("switching places is a state change", () => {
  it("A -> B -> A: B costs one request, going back costs none", async () => {
    const h = harness("/harare");
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    expect(h.calls.fetch).toEqual(["harare"]);

    // A -> B
    expect(await c.showSlug("nairobi-ke")).toBe(true);
    expect(h.calls.fetch).toEqual(["harare", "nairobi-ke"]);
    expect(c.getState().seed?.location.slug).toBe("nairobi-ke");
    expect(temp(c.getState())).toBe(-1);
    expect(h.calls.push).toEqual(["/nairobi-ke"]);

    // B -> A: from memory, no request and no device read.
    const recallsBefore = h.calls.recall.length;
    expect(await c.showSlug("harare")).toBe(true);
    expect(h.calls.fetch).toEqual(["harare", "nairobi-ke"]);
    expect(h.calls.recall.length).toBe(recallsBefore);
    expect(c.getState().seed?.location.slug).toBe("harare");
    expect(temp(c.getState())).toBe(-18);
    expect(h.calls.push).toEqual(["/nairobi-ke", "/harare"]);
  });

  it("shows the previous place until the next one is known, never a mix", async () => {
    const h = harness("/harare");
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    const snapshots: Array<[string | undefined, number | undefined]> = [];
    c.subscribe(() => {
      const s = c.getState();
      snapshots.push([s.seed?.location.slug, temp(s)]);
    });
    const release = h.hold("lagos-ng");
    const pending = c.showSlug("lagos-ng");
    await new Promise((r) => setTimeout(r, 40));
    // Lagos is on screen under its own name with no forecast yet: the
    // skeleton, not Harare's numbers.
    expect(c.getState().seed?.location.slug).toBe("lagos-ng");
    expect(c.getState().view).toBeNull();
    release();
    await pending;
    for (const [slug, t] of snapshots) {
      if (slug === "lagos-ng" && t !== undefined) expect(t).toBe(6);
      if (slug === "harare" && t !== undefined) expect(t).toBe(-18);
    }
    expect(temp(c.getState())).toBe(6);
  });

  it("only the latest switch wins, and the abandoned one is still kept for later", async () => {
    const h = harness("/harare");
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    const releaseB = h.hold("nairobi-ke");
    const toB = c.showSlug("nairobi-ke");
    await new Promise((r) => setTimeout(r, 40));
    await c.showSlug("lagos-ng"); // swiped on before B's forecast arrived
    releaseB();
    await toB;
    await new Promise((r) => setTimeout(r, 5)); // B's late answer lands
    expect(c.getState().seed?.location.slug).toBe("lagos-ng");
    expect(temp(c.getState())).toBe(6);
    // B's answer was paid for: swiping back to B needs no request.
    const before = h.calls.fetch.length;
    await c.showSlug("nairobi-ke");
    expect(h.calls.fetch.length).toBe(before);
    expect(temp(c.getState())).toBe(-1);
  });

  it("a copy older than the refresh window is shown at once and refreshed", async () => {
    const h = harness("/harare");
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    await c.showSlug("nairobi-ke");
    h.clock.now += REFRESH_AFTER_MS + 1000;
    const before = h.calls.fetch.length;
    const release = h.hold("harare");
    const back = c.showSlug("harare");
    await new Promise((r) => setTimeout(r, 5));
    expect(temp(c.getState())).toBe(-18); // memory copy, on screen
    expect(c.getState().fetching).toBe(true);
    release();
    await back;
    expect(h.calls.fetch.length).toBe(before + 1);
  });

  it("an unresolvable slug changes nothing and reports false", async () => {
    const h = harness("/harare");
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    expect(await c.showSlug("nowhere-xx")).toBe(false);
    expect(c.getState().seed?.location.slug).toBe("harare");
    expect(h.calls.push).toEqual([]);
    expect(h.path.current).toBe("/harare");
  });

  it("resolves a place from the device copy without asking the resolver", async () => {
    const h = harness("/harare");
    h.stored.set("nairobi-ke", storedView(NAIROBI, 15, 3 * 60_000));
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    await c.showSlug("nairobi-ke");
    expect(h.calls.resolve).toEqual([]);
    expect(temp(c.getState())).toBe(15);
    expect(h.calls.fetch).toEqual(["harare"]); // Nairobi's copy was fresh
  });

  it("tells the shell about every place it shows (title, store, cookie, scroll)", async () => {
    const h = harness("/harare");
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    await c.showSlug("nairobi-ke");
    await c.reconcile("/harare");
    expect(h.calls.shown).toEqual([
      "harare:none",
      "nairobi-ke:push",
      "harare:none",
    ]);
  });
});

describe("the URL follows the place (history.pushState, back/forward)", () => {
  it("does not push when the URL already names the place", async () => {
    const h = harness("/nairobi-ke");
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.showSlug("nairobi-ke");
    expect(h.calls.push).toEqual([]);
  });

  it("back/forward: a pathname change shows that place and never pushes", async () => {
    const h = harness("/harare");
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    await c.showSlug("nairobi-ke");
    h.path.current = "/harare"; // the browser went back
    expect(await c.reconcile("/harare")).toBe(true);
    expect(c.getState().seed?.location.slug).toBe("harare");
    expect(c.getState().path).toBe("/harare");
    expect(h.calls.push).toEqual(["/nairobi-ke"]);
    expect(h.calls.replace).toEqual([]);
  });

  it("ignores a pathname the state already shows and every non-place route", async () => {
    const h = harness("/harare");
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    const fetches = h.calls.fetch.length;
    expect(await c.reconcile("/harare")).toBe(true);
    expect(await c.reconcile("/harare/forecast")).toBe(true);
    expect(await c.reconcile("/explore")).toBe(true);
    expect(h.calls.fetch.length).toBe(fetches);
    expect(c.getState().seed?.location.slug).toBe("harare");
  });

  it("reports false for a place it cannot show so the page can load it from the server", async () => {
    const h = harness("/harare");
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    expect(await c.reconcile("/nowhere-xx")).toBe(false);
  });
});

describe("My Location (the silent-URL home)", () => {
  it("swaps the home place in place and keeps the URL at /", async () => {
    const h = harness("/");
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: true,
      path: "/",
    });
    await c.start();
    await c.showHome(NAIROBI);
    expect(c.getState().seed?.location.slug).toBe("nairobi-ke");
    expect(c.getState().isHome).toBe(true);
    expect(h.calls.push).toEqual([]);
    expect(c.homeSeed()?.location.slug).toBe("nairobi-ke");
  });

  it("home -> a saved place -> home returns to the home place with no request", async () => {
    const h = harness("/");
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: true,
      path: "/",
    });
    await c.start();
    await c.showSlug("lagos-ng");
    expect(c.getState().isHome).toBe(false);
    expect(h.path.current).toBe("/lagos-ng");
    const before = h.calls.fetch.length;
    expect(await c.showTarget({ kind: "home" })).toBe(true);
    expect(c.getState().isHome).toBe(true);
    expect(c.getState().seed?.location.slug).toBe("harare");
    expect(h.path.current).toBe("/");
    expect(h.calls.fetch.length).toBe(before);
  });

  it("a place stage that never knew the home place cannot show it", async () => {
    const h = harness("/harare");
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    expect(await c.showTarget({ kind: "home" })).toBe(false);
  });

  it("a GPS result found while the visitor is on another place does not pull them away", async () => {
    const h = harness("/");
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: true,
      path: "/",
    });
    await c.start();
    await c.showSlug("lagos-ng");
    const result = await c.showHome(NAIROBI);
    expect(result.shown).toBe(false);
    expect(c.getState().seed?.location.slug).toBe("lagos-ng");
    expect(c.homeSeed()?.location.slug).toBe("nairobi-ke");
    // They asked for it ("Use my location"): now it does move.
    await c.showHome(NAIROBI, { focus: true });
    expect(c.getState().seed?.location.slug).toBe("nairobi-ke");
    expect(c.getState().isHome).toBe(true);
    expect(h.path.current).toBe("/");
  });
});

describe("when the visitor's own request fails", () => {
  it("retries by itself (2 s, 5 s, 15 s) before it shows the notice, and recovers when the Worker does", async () => {
    const h = harness("/harare");
    h.failFetch.on = true;
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    // The first failure: the skeleton stays and no notice yet.
    expect(await c.start()).toEqual({ shown: true, failed: true });
    expect(c.getState().failed).toBe(false);
    expect(c.getState().fetching).toBe(true);

    expect(await h.runTimers()).toEqual([2_000]);
    expect(c.getState().failed).toBe(false);
    // The Worker comes back before the retries run out.
    h.failFetch.on = false;
    expect(await h.runTimers()).toEqual([5_000]);
    expect(temp(c.getState())).toBe(-18);
    expect(c.getState().failed).toBe(false);
    expect(c.getState().fetching).toBe(false);
    expect(h.calls.fetch).toEqual(["harare", "harare", "harare"]);
  });

  it("shows the notice once the retries are spent, and Try again fetches again, now", async () => {
    const h = harness("/harare");
    h.failFetch.on = true;
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    expect(await h.runTimers()).toEqual([2_000]);
    expect(await h.runTimers()).toEqual([5_000]);
    expect(await h.runTimers()).toEqual([15_000]);
    expect(c.getState().view).toBeNull();
    expect(c.getState().failed).toBe(true);
    expect(c.getState().fetching).toBe(false);
    expect(h.calls.fetch).toHaveLength(4);

    h.failFetch.on = false;
    const again = await c.retry();
    expect(again.failed).toBe(false);
    expect(c.getState().failed).toBe(false);
    expect(temp(c.getState())).toBe(-18);
  });

  it("a retry reads past the shared store's remembered failure", async () => {
    const h = harness("/harare");
    const forced: boolean[] = [];
    const inner = h.deps.fetchWeather;
    h.deps.fetchWeather = (lat, lon, signal, options) => {
      forced.push(options?.force ?? false);
      return inner(lat, lon, signal, options);
    };
    h.failFetch.on = true;
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    await h.runTimers();
    h.failFetch.on = false;
    await c.retry();
    // The first attempt is a normal read; every retry (timer or button) forces.
    expect(forced).toEqual([false, true, true]);
  });

  it("the browser coming back online makes one more attempt", async () => {
    const h = harness("/harare");
    h.failFetch.on = true;
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    await h.runTimers();
    await h.runTimers();
    await h.runTimers();
    expect(c.getState().failed).toBe(true);
    const before = h.calls.fetch.length;

    h.failFetch.on = false;
    h.clock.now += 5_000;
    c.nudge("online");
    await new Promise((r) => setTimeout(r, 5));
    expect(h.calls.fetch.length).toBe(before + 1);
    expect(temp(c.getState())).toBe(-18);
    expect(c.getState().failed).toBe(false);
  });

  it("leaving a place stops its retries", async () => {
    const h = harness("/harare");
    h.failFetch.on = true;
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    h.failFetch.on = false;
    await c.showSlug("nairobi-ke");
    const before = h.calls.fetch.length;
    expect(await h.runTimers()).toEqual([]); // Harare's retry timer was cancelled
    expect(h.calls.fetch.length).toBe(before);
    expect(c.getState().seed?.location.slug).toBe("nairobi-ke");
  });

  it("keeps the device copy on screen and says it is not live, once the retries are spent", async () => {
    const h = harness("/harare");
    h.stored.set("harare", storedView(HARARE, 21, REFRESH_AFTER_MS + 60_000));
    h.failFetch.on = true;
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    expect(temp(c.getState())).toBe(21);
    for (let i = 0; i < 3; i++) await h.runTimers();
    expect(temp(c.getState())).toBe(21);
    expect(c.getState().failed).toBe(true);
    expect(c.getState().device).not.toBeNull();
  });

  it("the Worker's seasonal estimate never replaces a real forecast on screen", async () => {
    const h = harness("/harare");
    h.stored.set("harare", storedView(HARARE, 21, REFRESH_AFTER_MS + 60_000));
    h.fallbackAnswer.on = true;
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    expect(temp(c.getState())).toBe(21);
    expect(c.getState().view?.usingFallback).toBe(false);
    expect(c.getState().failed).toBe(true);
  });

  it("with nothing stored the estimate is shown (flagged) but never remembered", async () => {
    const h = harness("/harare");
    h.fallbackAnswer.on = true;
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    await c.start();
    expect(c.getState().view?.usingFallback).toBe(true);
    expect(recallFromMemory("harare", NOW)).toBeNull();
  });

  it("an abandoned request cannot set the screen after dispose", async () => {
    const h = harness("/harare");
    const release = h.hold("harare");
    const c = createPlaceController(h.deps, {
      seed: HARARE,
      isHome: false,
      path: "/harare",
    });
    const done = c.start();
    await new Promise((r) => setTimeout(r, 5));
    c.dispose();
    release();
    await done;
    expect(c.getState().view).toBeNull();
  });
});

describe("a forecast that is slow to arrive (the skeleton says so, after 8 s)", () => {
  function lagos(h: Harness) {
    return createPlaceController(h.deps, {
      seed: LAGOS,
      isHome: false,
      path: "/lagos-ng",
    });
  }

  it("the threshold is 8 seconds, below the 22 s the retries take", () => {
    expect(SLOW_LOAD_AFTER_MS).toBe(8_000);
    // Two seconds, five and fifteen: the line comes well before "Couldn't load".
    expect(SLOW_LOAD_AFTER_MS).toBeLessThan(2_000 + 5_000 + 15_000);
  });

  it("starts the clock when the forecast is first asked for, not before", async () => {
    const h = harness("/lagos-ng");
    h.failFetch.on = true;
    const c = lagos(h);
    expect(h.pending()).toEqual([]);
    expect(c.getState().slow).toBe(false);
    await c.start();
    expect(h.pending()).toContain(SLOW_LOAD_AFTER_MS);
  });

  it("before 8 s there is no line: the first failure and the first retry stay silent", async () => {
    const h = harness("/lagos-ng");
    h.failFetch.on = true;
    const c = lagos(h);
    await c.start();
    expect(c.getState().slow).toBe(false);
    expect(await h.runTimers()).toEqual([2_000]);
    expect(c.getState().slow).toBe(false);
    expect(c.getState().failed).toBe(false);
  });

  it("at 8 s the skeleton stays and the line is up while the retries carry on", async () => {
    const h = harness("/lagos-ng");
    h.failFetch.on = true;
    const c = lagos(h);
    await c.start();
    await h.runTimers(); // the 2 s retry failed too
    expect(await h.fireSlow()).toBe(1);
    const s = c.getState();
    expect(s.slow).toBe(true);
    expect(s.view).toBeNull(); // still the skeleton
    expect(s.failed).toBe(false); // "Couldn't load" is the end of the retries
    expect(s.fetching).toBe(true);
    // The retry schedule is untouched: 5 s next, then 15 s.
    expect(await h.runTimers()).toEqual([5_000]);
    expect(c.getState().slow).toBe(true);
    expect(await h.runTimers()).toEqual([15_000]);
  });

  it("a request that hangs (never fails) is just as slow at 8 s", async () => {
    const h = harness("/lagos-ng");
    const release = h.hold("lagos-ng");
    const c = lagos(h);
    const started = c.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(c.getState().slow).toBe(false);
    await h.fireSlow();
    expect(c.getState().slow).toBe(true);
    // The forecast arrives late: the line goes with the skeleton.
    release();
    await started;
    expect(temp(c.getState())).toBe(6);
    expect(c.getState().slow).toBe(false);
  });

  it("when the retries are spent the existing failed state replaces the line", async () => {
    const h = harness("/lagos-ng");
    h.failFetch.on = true;
    const c = lagos(h);
    await c.start();
    await h.runTimers();
    await h.fireSlow();
    expect(c.getState().slow).toBe(true);
    await h.runTimers(); // 5 s
    await h.runTimers(); // 15 s: spent
    const s = c.getState();
    expect(s.failed).toBe(true);
    expect(s.slow).toBe(false); // never both
    expect(s.fetching).toBe(false);
    expect(s.view).toBeNull();
    expect(h.pending()).not.toContain(SLOW_LOAD_AFTER_MS);
  });

  it("a forecast clears it at any time, and cancels the clock when it comes first", async () => {
    // Before the line: the clock is cancelled, so the line can never appear late.
    clearPlaceMemory();
    const early = harness("/lagos-ng");
    early.failFetch.on = true;
    const a = lagos(early);
    await a.start();
    early.failFetch.on = false;
    await early.runTimers(); // the 2 s retry succeeds
    expect(temp(a.getState())).toBe(6);
    expect(early.pending()).not.toContain(SLOW_LOAD_AFTER_MS);
    expect(await early.fireSlow()).toBe(0);
    expect(a.getState().slow).toBe(false);

    // After the line is up: the forecast takes it down. (The first scenario
    // left Lagos in memory, which would answer without a request.)
    clearPlaceMemory();
    const late = harness("/lagos-ng");
    late.failFetch.on = true;
    const b = lagos(late);
    await b.start();
    await late.fireSlow();
    expect(b.getState().slow).toBe(true);
    late.failFetch.on = false;
    await late.runTimers();
    expect(temp(b.getState())).toBe(6);
    expect(b.getState().slow).toBe(false);
    expect(b.getState().failed).toBe(false);
  });

  it("never with something stored on screen: the saved copy is the answer to waiting", async () => {
    const h = harness("/lagos-ng");
    h.stored.set("lagos-ng", storedView(LAGOS, 30, REFRESH_AFTER_MS + 60_000));
    h.failFetch.on = true;
    const c = lagos(h);
    await c.start();
    expect(temp(c.getState())).toBe(30);
    await h.fireSlow();
    expect(c.getState().slow).toBe(false);
  });

  it("a slow device copy that lands after the line is up takes it down", async () => {
    const h = harness("/lagos-ng");
    h.failFetch.on = true;
    const late = storedView(LAGOS, 30, REFRESH_AFTER_MS + 60_000);
    let giveCopy!: () => void;
    h.deps.recall = () =>
      new Promise((resolve) => {
        giveCopy = () => resolve(late);
      });
    const c = lagos(h);
    await c.start(); // the device did not answer within recallTimeoutMs
    await h.fireSlow();
    expect(c.getState().slow).toBe(true);
    giveCopy();
    await new Promise((r) => setTimeout(r, 5));
    expect(temp(c.getState())).toBe(30);
    expect(c.getState().slow).toBe(false);
  });

  it("Try again from the line is a fresh forced read; the line goes and returns after another 8 s", async () => {
    const h = harness("/lagos-ng");
    const forced: boolean[] = [];
    const inner = h.deps.fetchWeather.bind(h.deps);
    h.deps.fetchWeather = (lat, lon, signal, options) => {
      forced.push(options?.force ?? false);
      return inner(lat, lon, signal, options);
    };
    h.failFetch.on = true;
    const c = lagos(h);
    await c.start();
    await h.fireSlow();
    expect(c.getState().slow).toBe(true);

    await c.retry();
    expect(forced[forced.length - 1]).toBe(true); // reads past the remembered failure
    expect(c.getState().slow).toBe(false);
    expect(h.pending()).toContain(SLOW_LOAD_AFTER_MS);
    await h.fireSlow();
    expect(c.getState().slow).toBe(true);

    // And it works: once the Worker is back, Try again shows the forecast.
    h.failFetch.on = false;
    await c.retry();
    expect(temp(c.getState())).toBe(6);
    expect(c.getState().slow).toBe(false);
  });

  it("leaving the place drops the line and its clock", async () => {
    const h = harness("/lagos-ng");
    h.failFetch.on = true;
    const c = lagos(h);
    await c.start();
    await h.fireSlow();
    expect(c.getState().slow).toBe(true);
    h.failFetch.on = false;
    await c.showSlug("harare");
    expect(c.getState().seed?.location.slug).toBe("harare");
    expect(c.getState().slow).toBe(false);
    expect(h.pending()).not.toContain(SLOW_LOAD_AFTER_MS);
  });

  it("an unresolvable slug stops the old place's retries, so its line is taken down too", async () => {
    const h = harness("/lagos-ng");
    h.failFetch.on = true;
    const c = lagos(h);
    await c.start();
    await h.fireSlow();
    expect(await c.showSlug("nowhere")).toBe(false);
    expect(c.getState().slow).toBe(false);
  });

  it("coming back online after the retries were spent keeps the notice and adds no line over it", async () => {
    const h = harness("/lagos-ng");
    h.failFetch.on = true;
    const c = lagos(h);
    await c.start();
    await h.fireSlow();
    for (let i = 0; i < 3; i++) await h.runTimers();
    expect(c.getState().failed).toBe(true);
    expect(c.getState().slow).toBe(false);

    // One more attempt, and it hangs: "Couldn't load" stays as it is.
    h.failFetch.on = false;
    const release = h.hold("lagos-ng");
    h.clock.now += 5_000;
    c.nudge("online");
    await new Promise((r) => setTimeout(r, 5));
    expect(h.pending()).not.toContain(SLOW_LOAD_AFTER_MS);
    expect(c.getState().failed).toBe(true);
    expect(c.getState().slow).toBe(false);
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(temp(c.getState())).toBe(6);
    expect(c.getState().failed).toBe(false);
  });

  it("disposing the stage cancels the clock", async () => {
    const h = harness("/lagos-ng");
    h.failFetch.on = true;
    const c = lagos(h);
    await c.start();
    c.dispose();
    expect(h.pending()).not.toContain(SLOW_LOAD_AFTER_MS);
    expect(c.getState().slow).toBe(false);
  });
});

describe("pure helpers", () => {
  it("isFreshEnough: current and younger than the refresh window", () => {
    const young = storedView(HARARE, 21, 60_000);
    expect(isFreshEnough(young, NOW)).toBe(true);
    const old = storedView(HARARE, 21, REFRESH_AFTER_MS + 1);
    expect(isFreshEnough(old, NOW)).toBe(false);
  });

  it("mergeStoredWithSeed: the server's season wins; a reconciled country is kept for a spot", () => {
    const spot = seed("somewhere--ksy4dd7", -17, "");
    const stored = {
      ...seedOfPayload({
        location: { ...spot.location, country: "ZW" },
        weather: weather(20),
        usingFallback: false,
        frostAlert: null,
        season: { name: "Old", localName: "Old", description: "" },
        countryName: "Zimbabwe",
      }),
      weather: weather(20),
      usingFallback: false,
      frostAlert: null,
    };
    const merged = mergeStoredWithSeed(stored, spot);
    expect(merged.season.name).toBe("Hot dry");
    expect(merged.location.country).toBe("ZW");
    expect(merged.countryName).toBe("Zimbabwe");
  });

  it("liveViewFor fills the country from the forecast's time zone and the height from its terrain", () => {
    const spot = seed("somewhere--ksy4dd7", -17, "");
    spot.location.elevation = 0;
    spot.location.elevationApproximate = true;
    spot.countryName = "";
    const view = liveViewFor(spot, weather(20), false);
    expect(view.location.country).toBe("ZW");
    expect(view.countryName).toBe("Zimbabwe");
    expect(view.location.elevation).toBe(1490);
    expect(view.usingFallback).toBe(false);
    const fallback = liveViewFor(spot, weather(20), true);
    expect(fallback.frostAlert).toBeNull();
  });

  it("keeps at most MEMORY_MAX_PLACES places, dropping the least recent", () => {
    for (let i = 0; i < MEMORY_MAX_PLACES + 3; i++) {
      const s = seed(`place-${i}`, i);
      rememberInMemory(
        {
          location: s.location,
          weather: weather(i),
          usingFallback: false,
          frostAlert: null,
          season: s.season,
          countryName: s.countryName,
        },
        NOW,
      );
    }
    expect(recallFromMemory("place-0", NOW)).toBeNull();
    expect(recallFromMemory("place-2", NOW)).toBeNull();
    expect(recallFromMemory("place-3", NOW)).not.toBeNull();
    expect(
      recallFromMemory(`place-${MEMORY_MAX_PLACES + 2}`, NOW),
    ).not.toBeNull();
  });

  it("memory re-bases an old copy on now and drops one the forecast no longer covers", () => {
    const s = seed("harare", -17.8);
    rememberInMemory(
      {
        location: s.location,
        weather: weather(20),
        usingFallback: false,
        frostAlert: null,
        season: s.season,
        countryName: s.countryName,
      },
      NOW,
    );
    const later = recallFromMemory("harare", NOW + 2 * HOUR);
    expect(later?.freshness).toBe("forecast");
    expect(recallFromMemory("harare", NOW + 30 * 24 * HOUR)).toBeNull();
    expect(recallFromMemory("harare", NOW)).toBeNull(); // dropped on the way
  });
});
