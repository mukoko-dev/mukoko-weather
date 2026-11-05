import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const held = vi.hoisted(() => ({
  reports: new Map<string, unknown>(),
  stored: [] as Array<{
    slug: string;
    fetchedAt: number;
    payload: { location: { name: string }; weather: unknown };
  }>,
  asked: [] as Array<{ slugs: readonly string[]; now: number | undefined }>,
}));

vi.mock("./worker-data", () => ({
  workerData: {
    peekSettled: (_route: string, query: { location: string }) =>
      held.reports.get(query.location),
  },
}));
vi.mock("./rxdb/weather-places", () => ({
  readPlaces: async (slugs: readonly string[], now?: number) => {
    held.asked.push({ slugs, now });
    return held.stored.filter((p) => slugs.includes(p.slug));
  },
}));

import {
  MAX_ALERT_SOURCE_PLACES,
  alertPlaceSlugs,
  loadAlertPlaces,
  loadAlerts,
  peekReports,
} from "./alerts-source";
import type { WeatherData } from "./weather";

const NOW = new Date("2026-07-10T14:05:00Z"); // 16:05 in Harare
const HOUR = 3_600_000;

function weather(frost: boolean): WeatherData {
  const time = Array.from({ length: 96 }, (_, i) =>
    new Date(Date.UTC(2026, 6, 10) + i * HOUR).toISOString().slice(0, 16),
  );
  return {
    utc_offset_seconds: 7200,
    hourly: {
      time,
      temperature_2m: time.map((_, i) =>
        frost && i >= 22 && i <= 30 ? 1 : 15,
      ),
      weather_code: time.map(() => 0),
      precipitation: time.map(() => 0),
    },
  } as unknown as WeatherData;
}

beforeEach(() => {
  held.reports.clear();
  held.stored = [];
  held.asked = [];
});

describe("alertPlaceSlugs", () => {
  it("lists the place on screen, Home, My Location, then the saved places, without repeats", () => {
    expect(
      alertPlaceSlugs({
        selectedLocation: "harare",
        homeLocation: "mutare",
        lastHomePlace: "harare",
        savedLocations: ["gweru", "mutare", "bulawayo"],
      }),
    ).toEqual(["harare", "mutare", "gweru", "bulawayo"]);
  });

  it("skips empty and missing entries", () => {
    expect(
      alertPlaceSlugs({
        selectedLocation: "",
        homeLocation: null,
        lastHomePlace: undefined,
        savedLocations: ["", "harare"],
      }),
    ).toEqual(["harare"]);
    expect(alertPlaceSlugs({})).toEqual([]);
  });

  it("is capped, so a long list is never a long read", () => {
    const saved = Array.from({ length: 40 }, (_, i) => `place-${i}`);
    const slugs = alertPlaceSlugs({ savedLocations: saved });
    expect(slugs).toHaveLength(MAX_ALERT_SOURCE_PLACES);
    expect(slugs[0]).toBe("place-0");
  });
});

describe("peekReports (reads the store, never asks the network)", () => {
  it("is null when nothing was fetched for the place in this tab", () => {
    expect(peekReports("harare")).toBeNull();
  });

  it("is null for a failed read, and the list for a good one", () => {
    held.reports.set("bad", { ok: false, data: null });
    expect(peekReports("bad")).toBeNull();
    held.reports.set("good", {
      ok: true,
      data: { reports: [{ reportType: "flooding", reportedAt: "x" }] },
    });
    expect(peekReports("good")).toEqual([
      { reportType: "flooding", reportedAt: "x" },
    ]);
  });

  it("treats a good answer with no list as an empty list", () => {
    held.reports.set("quiet", { ok: true, data: {} });
    expect(peekReports("quiet")).toEqual([]);
    held.reports.set("odd", { ok: true, data: { reports: "nope" } });
    expect(peekReports("odd")).toEqual([]);
  });
});

describe("loadAlertPlaces", () => {
  it("joins what is stored with what was fetched, in the order asked, and reads at the given time", async () => {
    held.stored = [
      {
        slug: "mutare",
        fetchedAt: 5,
        payload: { location: { name: "Mutare" }, weather: weather(false) },
      },
    ];
    held.reports.set("mutare", { ok: true, data: { reports: [] } });
    const places = await loadAlertPlaces(["harare", "mutare"], {}, 1234);
    expect(held.asked).toEqual([{ slugs: ["harare", "mutare"], now: 1234 }]);
    expect(places.map((p) => p.slug)).toEqual(["harare", "mutare"]);
    expect(places[1]).toMatchObject({
      name: "Mutare",
      fetchedAt: 5,
      reports: [],
    });
    // Nothing stored: no forecast, and a readable name from the slug.
    expect(places[0]).toMatchObject({
      name: "Harare",
      weather: null,
      fetchedAt: null,
      reports: null,
    });
  });

  it("names a place with no stored forecast from the person's label, then a name seen this session", async () => {
    const labelled = await loadAlertPlaces(["harare"], {
      labels: { harare: "Home" },
      names: { harare: "Harare" },
    });
    expect(labelled[0].name).toBe("Home");
    const seen = await loadAlertPlaces(["harare"], {
      names: { harare: "Harare City" },
    });
    expect(seen[0].name).toBe("Harare City");
  });
});

describe("loadAlerts", () => {
  it("applies the rules to the stored forecasts and the held reports", async () => {
    held.stored = [
      {
        slug: "harare",
        fetchedAt: NOW.getTime() - 10 * 60_000,
        payload: { location: { name: "Harare" }, weather: weather(true) },
      },
    ];
    held.reports.set("harare", {
      ok: true,
      data: {
        reports: [
          {
            reportType: "wildfire",
            severity: "moderate",
            reportedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
          },
        ],
      },
    });
    const result = await loadAlerts(["harare"], {}, NOW);
    expect(result.alerts.map((a) => a.id)).toEqual([
      "harare:frost:advisory",
      "harare:wildfire:community",
    ]);
    expect(result.placesChecked).toBe(1);
    expect(result.placesTotal).toBe(1);
  });

  it("is empty and checks nothing when nothing is stored", async () => {
    const result = await loadAlerts(["harare"], {}, NOW);
    expect(result.alerts).toEqual([]);
    expect(result.placesChecked).toBe(0);
    expect(result.placesTotal).toBe(1);
  });
});

describe("no request per place, no polling", () => {
  const read = (file: string) =>
    readFileSync(resolve(__dirname, file), "utf-8");
  const files = ["alerts-source.ts", "alerts-watch.ts", "use-alerts.ts"];

  it("never fetches: the alerts only peek at what the page already holds", () => {
    for (const file of files) {
      const src = read(file);
      expect(src, file).not.toMatch(/\bfetch\(/);
      expect(src, file).not.toMatch(/fetchWorker|postWorker/);
      expect(src, file).not.toMatch(/workerData\.(read|json)\(/);
    }
    expect(read("alerts-source.ts")).toContain("workerData.peekSettled");
  });

  it("never polls: no interval, only events", () => {
    for (const file of files) {
      expect(read(file), file).not.toMatch(/setInterval/);
    }
    const watch = read("alerts-watch.ts");
    expect(watch).toContain("subscribePlaces(schedule)");
    expect(watch).toContain("workerData.subscribe(");
    expect(watch).toContain('"visibilitychange"');
  });

  it("is loaded on demand, so none of it is in a page's first-load JavaScript", () => {
    const hook = read("use-alerts.ts");
    expect(hook).toContain('import("./alerts-watch")');
    // A type import is erased; a value import would pull it into the first load.
    expect(hook).not.toMatch(/^import (?!type).*alerts-watch/m);
    expect(hook).toContain("useIdleOnce(");
  });
});
