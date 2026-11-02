/**
 * How many times a location page calls the Worker (#414).
 *
 * Measured before the fix: one browser, one cold page load, about 150 calls in
 * two minutes (weather 60, haze 29, air-quality/grid 26, air-quality 23,
 * normals 23, geo 21, aviation/nearest-metar 19, locations/profile 4), 52 of
 * them refused with 429. The page below asks the way the sections do (the same
 * routes, the same arguments, pinned to the component sources at the bottom)
 * against a fake Worker that counts, including what LazySection does: a
 * section that scrolls far away is unmounted and mounts again when it returns,
 * so every section "mounts" several times in a session.
 *
 * The budget: at most 25 Worker calls for a cold place page, at most 8 for a
 * place already shown in this session, and never more than one request in
 * flight per route + cell.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, join } from "path";
import { workerData } from "./worker-data";
import { fetchAirQualityGrid } from "./aq-grid";
import { loadModelWeather } from "./home-weather";
import { loadReports } from "./reports-api";
import { COMPARISON_MODELS, createFallbackWeather } from "./weather";

const COLD_BUDGET = 25;
const REVISIT_BUDGET = 8;

/**
 * Calls the page makes that do NOT go through the shared store, because each
 * has its own cache or is once per app load: the place profile (own 30 min
 * cache), the activity catalogue and its categories (10 min cache), the
 * suitability rules and the suggested prompts (RxDB / 5 min cache), and the
 * device profile GET + PATCH (once per app load).
 */
const OTHER_COLD_CALLS = 7;

interface Place {
  slug: string;
  lat: number;
  lon: number;
}
const HARARE: Place = { slug: "harare", lat: -17.8292, lon: 31.0522 };
const NAIROBI: Place = { slug: "nairobi-ke", lat: -1.2921, lon: 36.8219 };
const LAGOS: Place = { slug: "lagos-ng", lat: 6.5244, lon: 3.3792 };

function fakeWorker() {
  const calls: string[] = [];
  const live = new Map<string, number>();
  let maxLivePerKey = 0;
  const fetcher = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    // The point's cell is the identity of a request.
    const lat = Number(url.searchParams.get("lat"));
    const lon = Number(url.searchParams.get("lon"));
    const key = `${url.pathname}|${Math.round(lat * 20)},${Math.round(lon * 20)}|${url.searchParams.get("date") ?? ""}`;
    calls.push(key);
    live.set(key, (live.get(key) ?? 0) + 1);
    maxLivePerKey = Math.max(maxLivePerKey, live.get(key) ?? 0);
    await new Promise((r) => setTimeout(r, 2));
    live.set(key, (live.get(key) ?? 1) - 1);
    if (url.pathname === "/v1/weather") {
      return new Response(
        JSON.stringify(createFallbackWeather(lat, lon, 1483)),
        { headers: { "X-Weather-Provider": "open-meteo:blend" } },
      );
    }
    return new Response(
      JSON.stringify({ available: true, reports: [], points: [], aqi: 42 }),
    );
  }) as unknown as typeof fetch;
  return {
    fetcher,
    calls,
    get maxLivePerKey() {
      return maxLivePerKey;
    },
  };
}

/** One mount of every section that reads the Worker, as the page mounts them. */
async function mountSections(p: Place, date = "2026-11-02") {
  const { lat, lon, slug } = p;
  await Promise.all([
    // AtmosphericSummary (eager): the air-quality tile, and the normal high
    // once the Conditions grid is near.
    workerData.json("air-quality", { lat, lon }),
    workerData.json("normals", { lat, lon, date }),
    // HazePanel (LazySection).
    workerData.json("haze", { lat, lon }),
    // AirQualityMapCard (LazySection).
    fetchAirQualityGrid({ lat, lon, radiusKm: 40, n: 7 }),
    // AviationWeather (LazySection).
    workerData.json("aviation/nearest-metar", { lat, lon }),
    // CommunityLane and RecentReports mount together and ask for one list.
    loadReports(slug),
    loadReports(slug),
    // The dashboard's model comparison + nowcast.
    loadModelWeather(lat, lon, "best_match", [...COMPARISON_MODELS]),
    // EnsoOutlook (farming places).
    workerData.json("enso", {}),
  ]);
}

/** A reader scrolling a page: sections unmount far away and mount again. */
async function readPage(p: Place, remounts = 6) {
  for (let i = 0; i < remounts; i++) await mountSections(p);
}

let worker: ReturnType<typeof fakeWorker>;
beforeEach(() => {
  workerData.reset();
  worker = fakeWorker();
  vi.stubGlobal("fetch", worker.fetcher);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a location page's calls to the Worker (#414)", () => {
  it("a cold place page makes at most 25 calls, even with every section mounted six times", async () => {
    await readPage(HARARE, 6);
    const shared = worker.calls.length;
    expect(shared).toBeLessThanOrEqual(9); // one per route + cell
    expect(shared + OTHER_COLD_CALLS).toBeLessThanOrEqual(COLD_BUDGET);
  });

  it("each route is asked once per cell, however many components ask", async () => {
    await readPage(HARARE, 6);
    const perRoute = new Map<string, number>();
    for (const c of worker.calls) {
      const route = c.split("|")[0];
      perRoute.set(route, (perRoute.get(route) ?? 0) + 1);
    }
    for (const [route, n] of perRoute) {
      expect(n, `${route} asked ${n} times`).toBe(1);
    }
    expect([...perRoute.keys()].sort()).toEqual(
      [
        "/v1/air-quality",
        "/v1/air-quality/grid",
        "/v1/aviation/nearest-metar",
        "/v1/enso",
        "/v1/haze",
        "/v1/normals",
        "/v1/reports",
        "/v1/weather",
      ].sort(),
    );
  });

  it("never has two requests in flight for one route + cell", async () => {
    await Promise.all([
      readPage(HARARE, 6),
      readPage(HARARE, 6),
      readPage({ ...HARARE, lat: HARARE.lat + 0.001 }, 3), // the same cell
    ]);
    expect(worker.maxLivePerKey).toBe(1);
  });

  it("a place already shown in this session costs at most 8 calls (it costs none)", async () => {
    await readPage(HARARE, 2);
    const before = worker.calls.length;
    await readPage(NAIROBI, 2);
    const afterNairobi = worker.calls.length;
    expect(afterNairobi).toBeGreaterThan(before); // Nairobi was a cold place
    await readPage(HARARE, 2); // swiped back
    const revisit = worker.calls.length - afterNairobi;
    expect(revisit).toBeLessThanOrEqual(REVISIT_BUDGET);
    expect(revisit).toBe(0);
  });

  it("swiping through three saved places stays far below the limiter, 600 a minute", async () => {
    for (const place of [HARARE, NAIROBI, LAGOS, NAIROBI, HARARE, LAGOS]) {
      await readPage(place, 3);
    }
    // Three cold places (9 shared calls each) plus the other calls each makes.
    expect(worker.calls.length).toBeLessThanOrEqual(3 * 9);
    expect(worker.calls.length + 3 * OTHER_COLD_CALLS).toBeLessThanOrEqual(
      3 * COLD_BUDGET,
    );
    // Which is also under the 120 a minute that tripped before.
    expect(worker.calls.length + 3 * OTHER_COLD_CALLS).toBeLessThan(120);
  });

  it("a nearby fix in the same 0.05 degree cell reuses the page's data", async () => {
    await readPage(HARARE, 1);
    const before = worker.calls.length;
    await mountSections({ ...HARARE, lat: HARARE.lat + 0.001 });
    expect(worker.calls.length).toBe(before);
  });

  it("data still refreshes on its normal cadence: conditions are read again after their keep time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    await readPage(HARARE, 1);
    const first = worker.calls.length;

    vi.setSystemTime(new Date("2026-11-02T10:00:50Z"));
    await readPage(HARARE, 1);
    expect(worker.calls.length).toBe(first); // 50 s: everything is still kept

    vi.setSystemTime(new Date("2026-11-02T10:12:00Z"));
    await readPage(HARARE, 1);
    const routes = worker.calls.slice(first).map((c) => c.split("|")[0]);
    // After 12 minutes the weather, reports, air quality, haze, grid and METAR
    // are read again; the 1 h climate normal and ENSO are not.
    expect(routes).toContain("/v1/weather");
    expect(routes).toContain("/v1/air-quality");
    expect(routes).toContain("/v1/haze");
    expect(routes).not.toContain("/v1/normals");
    expect(routes).not.toContain("/v1/enso");
  });
});

// ── The components really use the shared store (the list above is true) ────

const SRC = resolve(__dirname, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf-8");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

describe("the sections read the Worker through the shared store", () => {
  const SECTIONS: Array<[string, string]> = [
    ["components/weather/AtmosphericSummary.tsx", "useWorkerData<AqPayload>("],
    [
      "components/weather/AtmosphericSummary.tsx",
      "useWorkerData<NormalsPayload>(",
    ],
    ["components/weather/HazePanel.tsx", 'useWorkerData<HazeResponse>("haze"'],
    [
      "components/weather/AirQualityDetails.tsx",
      'useWorkerData<AirQualityResponse>("air-quality"',
    ],
    [
      "components/weather/EnsoOutlook.tsx",
      'useWorkerData<EnsoOutlookResponse>("enso"',
    ],
    ["components/weather/AviationWeather.tsx", '"aviation/nearest-metar"'],
    ["components/weather/CommunityLane.tsx", "loadReports<ReportLike>(slug)"],
    [
      "components/weather/reports/RecentReports.tsx",
      "loadReports<Report>(locationSlug)",
    ],
    ["lib/aq-grid.ts", "workerData.json<AqGridResponse>("],
    ["lib/use-live-weather.ts", "loadModelWeather("],
  ];

  for (const [file, needle] of SECTIONS) {
    it(`${file} asks through the shared store (${needle})`, () => {
      expect(read(file)).toContain(needle);
    });
  }

  it("no place-page component or hook calls fetchWorker/fetchPlaces for a read of its own", () => {
    const allowed = new Set([
      // A POST the visitor starts, not a read.
      join(SRC, "components/weather/HistoryAnalysis.tsx"),
    ]);
    const offenders = [
      ...sourceFiles(join(SRC, "components/weather")),
      ...sourceFiles(join(SRC, "app/[location]")),
    ].filter(
      (f) =>
        !allowed.has(f) &&
        /\bfetch(Worker|Places)\(/.test(readFileSync(f, "utf-8")),
    );
    expect(offenders).toEqual([]);
  });

  it("a reload on `online` is off, so coming back online never restarts the app", () => {
    expect(readFileSync(resolve(SRC, "..", "next.config.ts"), "utf-8")).toMatch(
      /reloadOnOnline:\s*false/,
    );
  });
});
