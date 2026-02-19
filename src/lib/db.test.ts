import { describe, it, expect, afterEach } from "vitest";
import {
  getTtlForLocation,
  isSummaryStale,
  type AISummaryDoc,
  getAllCountryCodes,
  getAllLocationSlugsForSitemap,
  getAllProvinces,
  getProvinceBySlug,
  getProvincesWithLocationCounts,
  syncRegions,
  getActiveRegions,
  getAllRegions,
  isInSupportedRegionFromDb,
  _clearRegionCache,
  syncTags,
  getAllTagsFromDb,
  getTagBySlug,
  getFeaturedTagsFromDb,
  syncSeasons,
  getSeasonFromDb,
  getSeasonForDate,
} from "./db";
import { REGIONS } from "./seed-regions";
import { TAGS } from "./seed-tags";
import { SEASONS } from "./seed-seasons";

describe("getTtlForLocation", () => {
  it("returns tier 1 (1800s) for major cities like harare", () => {
    const result = getTtlForLocation("harare");
    expect(result).toEqual({ seconds: 1800, tier: 1 });
  });

  it("returns tier 1 for all major city slugs", () => {
    const tier1Cities = [
      "harare", "bulawayo", "mutare", "gweru", "masvingo",
      "kwekwe", "kadoma", "marondera", "chinhoyi", "victoria-falls",
    ];
    for (const slug of tier1Cities) {
      const result = getTtlForLocation(slug);
      expect(result.tier).toBe(1);
      expect(result.seconds).toBe(1800);
    }
  });

  it("returns tier 2 (3600s) for locations with farming tag", () => {
    const result = getTtlForLocation("mazowe", ["farming"]);
    expect(result).toEqual({ seconds: 3600, tier: 2 });
  });

  it("returns tier 2 for locations with mining tag", () => {
    const result = getTtlForLocation("hwange", ["mining"]);
    expect(result).toEqual({ seconds: 3600, tier: 2 });
  });

  it("returns tier 2 for locations with education tag", () => {
    const result = getTtlForLocation("some-place", ["education"]);
    expect(result).toEqual({ seconds: 3600, tier: 2 });
  });

  it("returns tier 2 for locations with border tag", () => {
    const result = getTtlForLocation("some-place", ["border"]);
    expect(result).toEqual({ seconds: 3600, tier: 2 });
  });

  it("returns tier 3 (7200s) for unknown locations with no matching tags", () => {
    const result = getTtlForLocation("small-village", ["tourism"]);
    expect(result).toEqual({ seconds: 7200, tier: 3 });
  });

  it("returns tier 3 when no tags are provided for non-tier-1 slugs", () => {
    const result = getTtlForLocation("random-place");
    expect(result).toEqual({ seconds: 7200, tier: 3 });
  });

  it("tier 1 takes priority over tier 2 tags", () => {
    // Harare is tier 1, even if it has farming tags
    const result = getTtlForLocation("harare", ["farming"]);
    expect(result.tier).toBe(1);
  });

  it("handles empty tags array", () => {
    const result = getTtlForLocation("unknown", []);
    expect(result).toEqual({ seconds: 7200, tier: 3 });
  });
});

describe("isSummaryStale", () => {
  const baseCached: AISummaryDoc = {
    locationSlug: "harare",
    insight: "Test insight",
    generatedAt: new Date(),
    weatherSnapshot: { temperature: 25, weatherCode: 2 },
    expiresAt: new Date(Date.now() + 3600000),
    tier: 1,
  };

  it("returns false when temp and code are unchanged", () => {
    expect(isSummaryStale(baseCached, 25, 2)).toBe(false);
  });

  it("returns false when temperature delta is exactly 5", () => {
    expect(isSummaryStale(baseCached, 30, 2)).toBe(false);
    expect(isSummaryStale(baseCached, 20, 2)).toBe(false);
  });

  it("returns true when temperature delta exceeds 5", () => {
    expect(isSummaryStale(baseCached, 31, 2)).toBe(true);
    expect(isSummaryStale(baseCached, 19, 2)).toBe(true);
  });

  it("returns true when weather code changes", () => {
    expect(isSummaryStale(baseCached, 25, 63)).toBe(true);
  });

  it("returns true when both temp and code change", () => {
    expect(isSummaryStale(baseCached, 35, 95)).toBe(true);
  });

  it("returns false when temperature changes slightly and code is same", () => {
    expect(isSummaryStale(baseCached, 27, 2)).toBe(false);
    expect(isSummaryStale(baseCached, 23, 2)).toBe(false);
  });

  it("uses absolute value for temperature delta", () => {
    // Both +5.1 and -5.1 should be stale
    expect(isSummaryStale(baseCached, 30.1, 2)).toBe(true);
    expect(isSummaryStale(baseCached, 19.9, 2)).toBe(true);
  });
});

describe("new DB helper function exports", () => {
  it("getAllCountryCodes is a function", () => {
    expect(typeof getAllCountryCodes).toBe("function");
  });

  it("getAllLocationSlugsForSitemap is a function", () => {
    expect(typeof getAllLocationSlugsForSitemap).toBe("function");
  });

  it("getAllProvinces is a function", () => {
    expect(typeof getAllProvinces).toBe("function");
  });

  it("getProvinceBySlug is a function", () => {
    expect(typeof getProvinceBySlug).toBe("function");
  });

  it("getProvincesWithLocationCounts is a function", () => {
    expect(typeof getProvincesWithLocationCounts).toBe("function");
  });
});

describe("regions/tags/seasons DB function exports", () => {
  it("syncRegions is a function", () => {
    expect(typeof syncRegions).toBe("function");
  });

  it("getActiveRegions is a function", () => {
    expect(typeof getActiveRegions).toBe("function");
  });

  it("getAllRegions is a function", () => {
    expect(typeof getAllRegions).toBe("function");
  });

  it("isInSupportedRegionFromDb is a function", () => {
    expect(typeof isInSupportedRegionFromDb).toBe("function");
  });

  it("syncTags is a function", () => {
    expect(typeof syncTags).toBe("function");
  });

  it("getAllTagsFromDb is a function", () => {
    expect(typeof getAllTagsFromDb).toBe("function");
  });

  it("getTagBySlug is a function", () => {
    expect(typeof getTagBySlug).toBe("function");
  });

  it("getFeaturedTagsFromDb is a function", () => {
    expect(typeof getFeaturedTagsFromDb).toBe("function");
  });

  it("syncSeasons is a function", () => {
    expect(typeof syncSeasons).toBe("function");
  });

  it("getSeasonFromDb is a function", () => {
    expect(typeof getSeasonFromDb).toBe("function");
  });
});

describe("REGIONS seed data shape", () => {
  it("each region has required geometry fields", () => {
    for (const r of REGIONS) {
      expect(typeof r.id).toBe("string");
      expect(typeof r.north).toBe("number");
      expect(typeof r.south).toBe("number");
      expect(typeof r.east).toBe("number");
      expect(typeof r.west).toBe("number");
      expect(typeof r.padding).toBe("number");
      expect(typeof r.active).toBe("boolean");
    }
  });

  it("north is always greater than south in each region", () => {
    for (const r of REGIONS) {
      expect(r.north).toBeGreaterThan(r.south);
    }
  });

  it("east is always greater than west in each region (non-antimeridian regions)", () => {
    for (const r of REGIONS) {
      // All current regions don't cross the antimeridian
      expect(r.east).toBeGreaterThan(r.west);
    }
  });

  it("contains a Zimbabwe region with correct bounds", () => {
    const zw = REGIONS.find((r) => r.id === "zw");
    expect(zw).toBeDefined();
    // Zimbabwe is roughly -22.4 to -15.6 lat, 25.2 to 33.1 lon
    expect(zw!.south).toBeLessThan(-20);
    expect(zw!.north).toBeGreaterThan(-17);
    expect(zw!.west).toBeLessThan(27);
    expect(zw!.east).toBeGreaterThan(31);
  });

  it("all REGIONS are active", () => {
    expect(REGIONS.every((r) => r.active)).toBe(true);
  });
});

describe("TAGS seed data shape", () => {
  it("each tag has required fields", () => {
    for (const t of TAGS) {
      expect(typeof t.slug).toBe("string");
      expect(t.slug.length).toBeGreaterThan(0);
      expect(typeof t.label).toBe("string");
      expect(t.label.length).toBeGreaterThan(0);
      expect(typeof t.featured).toBe("boolean");
      expect(typeof t.order).toBe("number");
    }
  });

  it("tag slugs are unique", () => {
    const slugs = TAGS.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("tag order values are unique", () => {
    const orders = TAGS.map((t) => t.order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("includes the farming tag as featured", () => {
    const farming = TAGS.find((t) => t.slug === "farming");
    expect(farming).toBeDefined();
    expect(farming?.featured).toBe(true);
  });
});

describe("SEASONS seed data shape", () => {
  it("each season has required fields", () => {
    for (const s of SEASONS) {
      expect(typeof s.countryCode).toBe("string");
      expect(s.countryCode.length).toBe(2);
      expect(typeof s.name).toBe("string");
      expect(typeof s.localName).toBe("string");
      expect(Array.isArray(s.months)).toBe(true);
      expect(s.months.length).toBeGreaterThan(0);
      expect(["north", "south"]).toContain(s.hemisphere);
    }
  });

  it("months are valid 1-based values", () => {
    for (const s of SEASONS) {
      for (const m of s.months) {
        expect(m).toBeGreaterThanOrEqual(1);
        expect(m).toBeLessThanOrEqual(12);
      }
    }
  });

  it("Zimbabwe has exactly 4 seasons covering all 12 months", () => {
    const zwSeasons = SEASONS.filter((s) => s.countryCode === "ZW");
    expect(zwSeasons.length).toBe(4);
    const allMonths = zwSeasons.flatMap((s) => s.months).sort((a, b) => a - b);
    expect(allMonths).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe("getSeasonForDate fallback logic", () => {
  it("getSeasonForDate is a function", () => {
    expect(typeof getSeasonForDate).toBe("function");
  });

  it("returns a ZimbabweSeason shape with name, shona, description", async () => {
    // DB is unavailable in unit tests, so this always uses the sync fallback
    const season = await getSeasonForDate(new Date("2024-07-15"), "ZW");
    expect(typeof season.name).toBe("string");
    expect(typeof season.shona).toBe("string");
    expect(typeof season.description).toBe("string");
    expect(season.name.length).toBeGreaterThan(0);
  });

  it("returns 'Cool dry' for July (ZW southern hemisphere winter)", async () => {
    const season = await getSeasonForDate(new Date("2024-07-01"), "ZW");
    expect(season.name).toBe("Cool dry");
  });

  it("returns 'Hot dry' for October (ZW pre-rain season)", async () => {
    const season = await getSeasonForDate(new Date("2024-10-01"), "ZW");
    expect(season.name).toBe("Hot dry");
  });

  it("returns 'Main rains' for January (ZW wet season)", async () => {
    const season = await getSeasonForDate(new Date("2024-01-15"), "ZW");
    expect(season.name).toBe("Main rains");
  });
});

describe("_clearRegionCache", () => {
  afterEach(() => {
    _clearRegionCache();
  });

  it("is a function for test teardown", () => {
    expect(typeof _clearRegionCache).toBe("function");
  });

  it("clears the cache so subsequent calls retry DB", () => {
    // Simply verify calling it doesn't throw
    expect(() => _clearRegionCache()).not.toThrow();
    expect(() => _clearRegionCache()).not.toThrow(); // idempotent
  });
});
