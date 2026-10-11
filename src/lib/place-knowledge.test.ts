import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";

import {
  PLACE_PROFILE_TTL_MS,
  fetchPlaceProfile,
  peekPlaceProfile,
  placeProfileUrl,
  profileRows,
  resetPlaceProfileCache,
  shortDate,
  type PlaceProfile,
} from "./place-knowledge";

const HARARE: PlaceProfile = {
  climate: {
    koppen: { code: "Cwb", label: "subtropical highland, dry winter" },
  },
  agriculture: null,
  current: {
    month: 10,
    season: { name: "Hot dry", localName: "Zhizha", verified: true },
    nextSeason: {
      name: "Main rains",
      localName: "Masika",
      startsOn: "2026-11-01",
    },
    normalsThisMonth: {
      month: 10,
      meanHighC: 26.5,
      meanLowC: 16.5,
      precipMm: 30,
    },
    cropPhases: [
      {
        crop: "maize",
        cropLabel: "Maize",
        season: null,
        phaseLabel: "Out of season",
        nextPhaseLabel: "Planting to early vegetative",
        nextPhaseOn: "2026-11-01",
      },
    ],
    inDerivedGrowingWindow: null,
  },
};

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

afterEach(() => {
  resetPlaceProfileCache();
  vi.useRealTimers();
});

describe("placeProfileUrl", () => {
  it("encodes the slug and adds rounded coordinates when given", () => {
    expect(placeProfileUrl("harare")).toBe(
      "/api/py/locations/profile?slug=harare",
    );
    expect(placeProfileUrl("a b", -17.83123, 31.05)).toBe(
      "/api/py/locations/profile?slug=a+b&lat=-17.8312&lon=31.0500",
    );
  });
});

describe("shortDate", () => {
  it("formats an ISO date and ignores anything else", () => {
    expect(shortDate("2026-11-01")).toBe("1 Nov");
    expect(shortDate("2027-04-16")).toBe("16 Apr");
    expect(shortDate("soon")).toBe("");
  });
});

describe("profileRows", () => {
  it("shows climate, typical month, next season and crop calendar", () => {
    const rows = profileRows(HARARE);
    expect(rows.map((r) => r.label)).toEqual([
      "Climate zone",
      "Typical in October",
      "Next season",
      "Crop calendar",
    ]);
    expect(rows[0].value).toBe(
      "Subtropical highland, dry winter (Cwb), estimated",
    );
    expect(rows[1].value).toBe("27° high, 17° low, 30 mm of rain");
    expect(rows[2].value).toBe("Masika from 1 Nov");
    expect(rows[3].value).toBe(
      "Maize: out of season, planting to early vegetative from 1 Nov",
    );
  });

  it("marks an unverified season calendar as estimated", () => {
    const rows = profileRows({
      ...HARARE,
      current: {
        ...HARARE.current!,
        season: { name: "Summer", localName: null, verified: false },
      },
    });
    expect(rows.find((r) => r.label === "Next season")!.value).toBe(
      "Masika from 1 Nov, estimated",
    );
  });

  it("names the season of a multi-season crop and caps the list at two", () => {
    const phase = HARARE.current!.cropPhases[0];
    const rows = profileRows({
      ...HARARE,
      current: {
        ...HARARE.current!,
        cropPhases: [
          { ...phase, season: "Long rains" },
          { ...phase, season: "Short rains" },
          { ...phase, cropLabel: "Rice", season: null },
        ],
      },
    });
    const value = rows.find((r) => r.label === "Crop calendar")!.value;
    expect(value).toContain("Maize (long rains)");
    expect(value).toContain("Maize (short rains)");
    expect(value).not.toContain("Rice");
  });

  it("falls back to an estimated growing window, naming no crops", () => {
    const rows = profileRows({
      ...HARARE,
      agriculture: { derived: { months: [5, 6, 7, 8, 9, 10], basis: "x" } },
      current: {
        ...HARARE.current!,
        cropPhases: [],
        inDerivedGrowingWindow: true,
      },
    });
    const row = rows.find((r) => r.label === "Growing window")!;
    expect(row.value).toBe("May–Oct, now inside it, estimated");
    expect(rows.some((r) => r.label === "Crop calendar")).toBe(false);
  });

  it("handles a growing window that wraps the year end", () => {
    const rows = profileRows({
      ...HARARE,
      agriculture: { derived: { months: [11, 12, 1, 2, 3], basis: "x" } },
      current: {
        ...HARARE.current!,
        cropPhases: [],
        inDerivedGrowingWindow: false,
      },
    });
    expect(rows.find((r) => r.label === "Growing window")!.value).toBe(
      "Nov–Mar, now outside it, estimated",
    );
  });

  it("returns nothing without a profile or without current context", () => {
    expect(profileRows(null)).toEqual([]);
    expect(profileRows({ ...HARARE, current: null })).toEqual([]);
  });

  it("skips groups that are missing", () => {
    const rows = profileRows({
      climate: { koppen: null },
      agriculture: null,
      current: {
        ...HARARE.current!,
        normalsThisMonth: null,
        nextSeason: null,
        cropPhases: [],
      },
    });
    expect(rows).toEqual([]);
  });
});

describe("fetchPlaceProfile", () => {
  it("caches a profile and shares one in-flight request", async () => {
    const fetcher = vi.fn().mockResolvedValue(okResponse(HARARE));
    const [a, b] = await Promise.all([
      fetchPlaceProfile("harare", fetcher),
      fetchPlaceProfile("harare", fetcher),
    ]);
    expect(a).toEqual(HARARE);
    expect(b).toEqual(HARARE);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await fetchPlaceProfile("harare", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(peekPlaceProfile("harare")).toEqual(HARARE);
  });

  it("expires after the TTL", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(okResponse(HARARE));
    await fetchPlaceProfile("harare", fetcher);
    expect(
      peekPlaceProfile("harare", Date.now() + PLACE_PROFILE_TTL_MS + 1),
    ).toBeUndefined();
  });

  it("rejects on HTTP errors and non-profile bodies, caching nothing", async () => {
    await expect(
      fetchPlaceProfile(
        "x",
        vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response),
      ),
    ).rejects.toThrow("HTTP 404");
    await expect(
      fetchPlaceProfile(
        "x",
        vi.fn().mockResolvedValue(okResponse({ nope: true })),
      ),
    ).rejects.toThrow("not a profile");
    expect(peekPlaceProfile("x")).toBeUndefined();
  });
});

describe("PlaceKnowledgeRows wiring", () => {
  const component = fs.readFileSync(
    "src/components/weather/PlaceKnowledgeRows.tsx",
    "utf-8",
  );
  const dashboard = fs.readFileSync(
    "src/app/[location]/WeatherDashboard.tsx",
    "utf-8",
  );

  it("renders nothing until there are rows, with no styles outside tokens", () => {
    expect(component).toContain("if (rows.length === 0) return null;");
    expect(component).not.toMatch(/style=\{\{/);
    expect(component).not.toMatch(/["'`]#[0-9a-fA-F]{3,8}["'`]/);
  });

  it("is a labelled description list built on InfoRow, aborting on unmount", () => {
    expect(component).toContain("aria-labelledby={labelledBy}");
    expect(component).toContain("<InfoRow");
    expect(component).toContain("controller.abort()");
  });

  it("sits inside the About card, in an error boundary, keyed by slug", () => {
    const about = dashboard.slice(
      dashboard.indexOf("{/* Location info card */}"),
    );
    expect(about).toContain('<ChartErrorBoundary name="place knowledge">');
    expect(about).toContain("<PlaceKnowledgeRows");
    expect(about).toContain("key={location.slug}");
    expect(about).toContain("labelledBy={`about-${location.slug}`}");
  });

  it("reads only the public profile endpoint, never AI", () => {
    const lib = fs.readFileSync("src/lib/place-knowledge.ts", "utf-8");
    expect(lib).toContain("/api/py/locations/profile");
    expect(lib).not.toContain("/api/ai");
  });
});
