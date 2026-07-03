import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
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
  vectorSearchLocations,
  storeLocationEmbedding,
  storeLocationEmbeddings,
  getTagCountsAndStats,
  getAtlasSearchIndexDefinitions,
  _resetSearchFlags,
  getLocationCount,
  VALID_CONDITION_FIELDS,
  stampPlatformFields,
  PLATFORM_SCHEMA_VERSION,
  DEFAULT_COUNTRY_CODE,
  isIndexConflictError,
} from "./db";
import { REGIONS } from "./seed-regions";
import { TAGS } from "./seed-tags";
import { SEASONS } from "./seed-seasons";
import { LOCATIONS } from "./locations";
import { PROVINCES, generateProvinceSlug } from "./countries";

describe("getTtlForLocation", () => {
  it("returns tier 1 (1800s) for locations with city tag", () => {
    const result = getTtlForLocation("any-city", ["city"]);
    expect(result).toEqual({ seconds: 1800, tier: 1 });
  });

  it("returns tier 1 for any slug with city tag", () => {
    const cities = ["nairobi-ke", "harare-zw", "london-gb", "bangkok-th"];
    for (const slug of cities) {
      const result = getTtlForLocation(slug, ["city"]);
      expect(result.tier).toBe(1);
      expect(result.seconds).toBe(1800);
    }
  });

  it("returns tier 2 (3600s) for locations with farming tag", () => {
    const result = getTtlForLocation("mazowe-zw", ["farming"]);
    expect(result).toEqual({ seconds: 3600, tier: 2 });
  });

  it("returns tier 2 for locations with mining tag", () => {
    const result = getTtlForLocation("hwange-zw", ["mining"]);
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

  it("returns tier 3 when no tags are provided", () => {
    const result = getTtlForLocation("random-place");
    expect(result).toEqual({ seconds: 7200, tier: 3 });
  });

  it("tier 1 (city) takes priority over tier 2 tags", () => {
    const result = getTtlForLocation("nairobi-ke", ["city", "farming"]);
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

  it("getLocationCount is a function", () => {
    expect(typeof getLocationCount).toBe("function");
  });

  it("getLocationCount returns the static seed catalog length (Phase 0F)", () => {
    // Phase 0F: weather.locations is dropped, so getLocationCount returns
    // LOCATIONS.length from the static seed array (no DB round-trip).
    const dbSource = readFileSync(resolve(__dirname, "db.ts"), "utf-8");

    const fnStart = dbSource.indexOf("async function getLocationCount");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = dbSource.indexOf("}", fnStart) + 1;
    const fnBody = dbSource.slice(fnStart, fnEnd);

    expect(fnBody).toContain("LOCATIONS.length");
    expect(fnBody).not.toContain("estimatedDocumentCount");
  });
});

describe("province readers derive from LOCATIONS (union with static PROVINCES)", () => {
  const slugForLoc = (l: (typeof LOCATIONS)[number]) =>
    l.provinceSlug ?? generateProvinceSlug(l.province, l.country ?? "");

  // Pick a country that has seed LOCATIONS but NO static PROVINCES rows, so its
  // provinces MUST be derived. Singapore (SG) is the canonical example.
  const derivedOnlyCode = "SG";

  it("derives provinces for a country with no static PROVINCES rows", async () => {
    const sgLocations = LOCATIONS.filter(
      (l) => (l.country ?? "").toUpperCase() === derivedOnlyCode,
    );
    expect(sgLocations.length).toBeGreaterThan(0);
    // Precondition for the test: SG genuinely has no static province rows.
    expect(PROVINCES.some((p) => p.countryCode.toUpperCase() === derivedOnlyCode)).toBe(false);

    const provinces = await getProvincesWithLocationCounts(derivedOnlyCode);

    // Every SG location's province slug is represented exactly once.
    const expectedSlugs = new Set(sgLocations.map(slugForLoc));
    const returnedSlugs = provinces.map((p) => p.slug);
    expect(new Set(returnedSlugs).size).toBe(returnedSlugs.length); // no dupes
    for (const slug of expectedSlugs) {
      expect(returnedSlugs).toContain(slug);
    }

    // Counts are correct: sum of derived counts equals SG's location total.
    const total = provinces.reduce((sum, p) => sum + p.locationCount, 0);
    expect(total).toBe(sgLocations.length);
    // Each derived province carries its human province name, not the slug.
    for (const p of provinces) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.name).not.toBe(p.slug);
    }
  });

  it("getProvinceBySlug resolves a derived (non-static) province", async () => {
    const sgLoc = LOCATIONS.find((l) => (l.country ?? "").toUpperCase() === derivedOnlyCode);
    expect(sgLoc).toBeTruthy();
    const slug = slugForLoc(sgLoc!);

    // Not present in the static catalog — must be derived.
    expect(PROVINCES.some((p) => p.slug === slug)).toBe(false);

    const province = await getProvinceBySlug(slug);
    expect(province).not.toBeNull();
    expect(province!.slug).toBe(slug);
    expect(province!.name).toBe(sgLoc!.province);
    expect(province!.countryCode).toBe(derivedOnlyCode);
  });

  it("every seed location is reachable via exactly one province card (all countries)", async () => {
    const codes = new Set(
      LOCATIONS.map((l) => (l.country ?? "").toUpperCase()).filter(Boolean),
    );
    for (const code of codes) {
      const countryLocs = LOCATIONS.filter((l) => (l.country ?? "").toUpperCase() === code);
      const provinces = await getProvincesWithLocationCounts(code);
      const bySlug = new Map(provinces.map((p) => [p.slug, p.locationCount]));
      // Each location's province slug exists in the returned catalog.
      for (const loc of countryLocs) {
        expect(bySlug.has(slugForLoc(loc))).toBe(true);
      }
      // Total counted equals the number of seed locations in the country.
      const total = provinces.reduce((sum, p) => sum + p.locationCount, 0);
      expect(total).toBe(countryLocs.length);
    }
  });

  it("getAllProvinces includes derived provinces for sitemap coverage", async () => {
    const all = await getAllProvinces();
    const allSlugs = new Set(all.map((p) => p.slug));
    // Every province slug that any seed location maps to is present.
    for (const loc of LOCATIONS) {
      if (!(loc.country ?? "")) continue;
      expect(allSlugs.has(slugForLoc(loc))).toBe(true);
    }
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

  it("east is always greater than west for standard regions; antimeridian-crossing regions have east < west", () => {
    for (const r of REGIONS) {
      // Antimeridian-crossing regions (e.g. Pacific Islands) have east < west by convention
      if (r.id === "pacific-islands") {
        // east (-176°) < west (130°) for antimeridian-crossing regions
        expect(r.east).toBeLessThan(r.west);
      } else {
        expect(r.east).toBeGreaterThan(r.west);
      }
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
      expect(["north", "south", "equatorial"]).toContain(s.hemisphere);
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

  it("every country's seasons cover all 12 months", () => {
    const byCountry = new Map<string, number[]>();
    for (const s of SEASONS) {
      const months = byCountry.get(s.countryCode) ?? [];
      months.push(...s.months);
      byCountry.set(s.countryCode, months);
    }
    for (const [code, months] of byCountry) {
      const unique = [...new Set(months)].sort((a, b) => a - b);
      const missing = [1,2,3,4,5,6,7,8,9,10,11,12].filter(m => !unique.includes(m));
      if (missing.length > 0) {
        throw new Error(`${code} seasons do not cover all 12 months (missing: ${missing.join(", ")})`);
      }
      expect(unique).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    }
  });

  it("covers all major regions (Africa, ASEAN)", () => {
    const codes = new Set(SEASONS.map((s) => s.countryCode));
    // Southern Africa
    expect(codes.has("ZW")).toBe(true);
    expect(codes.has("ZA")).toBe(true);
    expect(codes.has("ZM")).toBe(true);
    // East Africa
    expect(codes.has("KE")).toBe(true);
    expect(codes.has("TZ")).toBe(true);
    expect(codes.has("ET")).toBe(true);
    // West Africa
    expect(codes.has("NG")).toBe(true);
    expect(codes.has("GH")).toBe(true);
    // North Africa
    expect(codes.has("EG")).toBe(true);
    expect(codes.has("MA")).toBe(true);
    // ASEAN
    expect(codes.has("TH")).toBe(true);
    expect(codes.has("ID")).toBe(true);
    expect(codes.has("PH")).toBe(true);
    expect(codes.has("MY")).toBe(true);
    expect(codes.has("VN")).toBe(true);
  });

  it("has more than 50 unique country codes", () => {
    const codes = new Set(SEASONS.map((s) => s.countryCode));
    expect(codes.size).toBeGreaterThan(50);
  });
});

describe("getSeasonForDate fallback logic", () => {
  it("getSeasonForDate is a function", () => {
    expect(typeof getSeasonForDate).toBe("function");
  });

  it("returns a Season shape with name, localName, description", async () => {
    // DB is unavailable in unit tests, so this always uses the hemisphere-aware fallback
    const season = await getSeasonForDate(new Date("2024-07-15"), "", -17);
    expect(typeof season.name).toBe("string");
    expect(typeof season.localName).toBe("string");
    expect(typeof season.description).toBe("string");
    expect(season.name.length).toBeGreaterThan(0);
  });

  it("returns 'Winter' for July in southern hemisphere", async () => {
    const season = await getSeasonForDate(new Date("2024-07-01"), "", -17);
    expect(season.name).toBe("Winter");
  });

  it("returns 'Spring' for October in southern hemisphere", async () => {
    const season = await getSeasonForDate(new Date("2024-10-01"), "", -17);
    expect(season.name).toBe("Spring");
  });

  it("returns 'Summer' for January in southern hemisphere", async () => {
    const season = await getSeasonForDate(new Date("2024-01-15"), "", -17);
    expect(season.name).toBe("Summer");
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

describe("Atlas Search and Vector Search functions", () => {
  it("vectorSearchLocations is a function", () => {
    expect(typeof vectorSearchLocations).toBe("function");
  });

  it("storeLocationEmbedding is a function", () => {
    expect(typeof storeLocationEmbedding).toBe("function");
  });

  it("storeLocationEmbeddings is a function", () => {
    expect(typeof storeLocationEmbeddings).toBe("function");
  });

  it("getTagCountsAndStats is a function", () => {
    expect(typeof getTagCountsAndStats).toBe("function");
  });

  it("_resetSearchFlags resets timestamps and embedding guard", () => {
    expect(typeof _resetSearchFlags).toBe("function");
    // Should be safe to call multiple times (idempotent)
    expect(() => _resetSearchFlags()).not.toThrow();
    expect(() => _resetSearchFlags()).not.toThrow();
  });
});

describe("Atlas Search time-based recovery", () => {
  it("uses ATLAS_RETRY_AFTER_MS constant for recovery timing", () => {
    // Verify the module exports the reset function (timestamps are internal)
    // and that the time-based pattern is in place by reading the source
    const dbSource = readFileSync(resolve(__dirname, "db.ts"), "utf-8");
    expect(dbSource).toContain("ATLAS_RETRY_AFTER_MS");
    expect(dbSource).toContain("5 * 60 * 1000");
  });

  it("disables activity Atlas Search with a timestamp, not a permanent boolean", () => {
    // Phase 0F: location Atlas Search / Vector Search disabling removed —
    // those paths now run against `places.placesGeo` (managed by the
    // platform). Only the activity Atlas Search retains the local
    // time-based circuit breaker.
    const dbSource = readFileSync(resolve(__dirname, "db.ts"), "utf-8");
    expect(dbSource).toContain("atlasActivitySearchDisabledAt = Date.now()");
    expect(dbSource).not.toContain("atlasActivitySearchAvailable = false");
  });

  it("only matches code 40324 and 'index not found' — not broad $search or PlanExecutor strings", () => {
    const dbSource = readFileSync(resolve(__dirname, "db.ts"), "utf-8");
    // Should match specific permanent-error indicators
    expect(dbSource).toContain("mongoErr.code === 40324");
    expect(dbSource).toContain('msg.includes("index not found")');
    // Should NOT match broad strings that could hit transient errors
    expect(dbSource).not.toContain('msg.includes("$search")');
    expect(dbSource).not.toContain('msg.includes("PlanExecutor")');
  });

  it("checks time elapsed since disable before skipping activity Atlas Search", () => {
    const dbSource = readFileSync(resolve(__dirname, "db.ts"), "utf-8");
    expect(dbSource).toContain("Date.now() - atlasActivitySearchDisabledAt > ATLAS_RETRY_AFTER_MS");
  });
});

describe("Vector Search (Phase 0F neutralised)", () => {
  it("vectorSearchLocations returns an empty array (no weather.locations to search)", async () => {
    // Phase 0F: weather.locations is dropped. Vector search will be
    // reimplemented against shamwari.knowledgeBase or places.places later.
    const result = await vectorSearchLocations([0.1, 0.2, 0.3]);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("storeLocationEmbedding is a no-op", async () => {
    await expect(storeLocationEmbedding("anywhere", [0.1])).resolves.toBeUndefined();
  });

  it("storeLocationEmbeddings is a no-op", async () => {
    await expect(storeLocationEmbeddings([])).resolves.toBeUndefined();
  });
});

describe("getAtlasSearchIndexDefinitions", () => {
  const defs = getAtlasSearchIndexDefinitions();

  it("returns locationSearch, activitySearch, and locationVector", () => {
    expect(defs).toHaveProperty("locationSearch");
    expect(defs).toHaveProperty("activitySearch");
    expect(defs).toHaveProperty("locationVector");
  });

  it("locationSearch targets the locations collection", () => {
    expect(defs.locationSearch).toHaveProperty("collectionName", "locations");
    expect(defs.locationSearch).toHaveProperty("name", "location_search");
    expect(defs.locationSearch).toHaveProperty("type", "search");
  });

  it("activitySearch targets the activities collection", () => {
    expect(defs.activitySearch).toHaveProperty("collectionName", "activities");
    expect(defs.activitySearch).toHaveProperty("name", "activity_search");
    expect(defs.activitySearch).toHaveProperty("type", "search");
  });

  it("locationVector is a vectorSearch type", () => {
    expect(defs.locationVector).toHaveProperty("collectionName", "locations");
    expect(defs.locationVector).toHaveProperty("name", "location_vector");
    expect(defs.locationVector).toHaveProperty("type", "vectorSearch");
  });

  it("locationVector uses cosine similarity with 1024 dimensions", () => {
    const def = defs.locationVector as { definition: { fields: { numDimensions?: number; similarity?: string }[] } };
    const vectorField = def.definition.fields.find((f) => f.numDimensions !== undefined);
    expect(vectorField).toBeDefined();
    expect(vectorField!.numDimensions).toBe(1024);
    expect(vectorField!.similarity).toBe("cosine");
  });

  it("locationSearch has autocomplete mapping on name field", () => {
    const def = defs.locationSearch as { definition: { mappings: { fields: { name: { type: string }[] } } } };
    const nameFields = def.definition.mappings.fields.name;
    expect(Array.isArray(nameFields)).toBe(true);
    expect(nameFields.some((f) => f.type === "autocomplete")).toBe(true);
  });
});

// ── VALID_CONDITION_FIELDS ─────────────────────────────────────────────────

describe("VALID_CONDITION_FIELDS", () => {
  it("contains all WeatherInsights numeric fields", () => {
    const expected = [
      "gdd10To30", "gdd10To31", "gdd08To30", "gdd03To25",
      "evapotranspiration", "dewPoint", "precipitationType",
      "windSpeed", "windGust",
      "thunderstormProbability", "heatStressIndex", "uvHealthConcern",
      "moonPhase", "cloudBase", "cloudCeiling", "visibility",
    ];
    for (const field of expected) {
      expect(VALID_CONDITION_FIELDS.has(field)).toBe(true);
    }
  });

  it("rejects unknown field names", () => {
    expect(VALID_CONDITION_FIELDS.has("typoField")).toBe(false);
    expect(VALID_CONDITION_FIELDS.has("windspeed")).toBe(false); // wrong case
    expect(VALID_CONDITION_FIELDS.has("temperature")).toBe(false);
  });

  it("seed suitability rules only use valid fields", async () => {
    const { SUITABILITY_RULES } = await import("./seed-suitability-rules");
    for (const rule of SUITABILITY_RULES) {
      for (const cond of rule.conditions) {
        expect(
          VALID_CONDITION_FIELDS.has(cond.field),
          `Invalid field "${cond.field}" in rule "${rule.key}"`,
        ).toBe(true);
      }
    }
  });
});

describe("stampPlatformFields", () => {
  it("exposes the expected schema version + default country", () => {
    expect(PLATFORM_SCHEMA_VERSION).toBe("v3.1");
    expect(DEFAULT_COUNTRY_CODE).toBe("ZW");
  });

  it("stamps all required fields on an empty doc", () => {
    const result = stampPlatformFields({});
    expect(typeof result._id).toBe("string");
    expect(result._id.length).toBeGreaterThan(0);
    expect(result._schemaVersion).toBe("v3.1");
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.updatedAt).toBeInstanceOf(Date);
    expect(result.bundu).toEqual({ countryCode: "ZW" });
  });

  it("defaults country code to ZW", () => {
    const result = stampPlatformFields({});
    expect(result.bundu.countryCode).toBe("ZW");
  });

  it("respects the countryCode option", () => {
    const result = stampPlatformFields({}, { countryCode: "KE" });
    expect(result.bundu.countryCode).toBe("KE");
  });

  it("includes provinceSlug when provided", () => {
    const result = stampPlatformFields({}, { countryCode: "ZW", provinceSlug: "harare" });
    expect(result.bundu.provinceSlug).toBe("harare");
  });

  it("omits provinceSlug when not provided", () => {
    const result = stampPlatformFields({}, { countryCode: "ZW" });
    expect(result.bundu.provinceSlug).toBeUndefined();
  });

  it("preserves an existing _id", () => {
    const result = stampPlatformFields({ _id: "abc-123" });
    expect(result._id).toBe("abc-123");
  });

  it("preserves an existing _schemaVersion (e.g. v3.2)", () => {
    const result = stampPlatformFields({ _schemaVersion: "v3.2" });
    expect(result._schemaVersion).toBe("v3.2");
  });

  it("preserves an existing createdAt", () => {
    const original = new Date("2024-01-01T00:00:00Z");
    const result = stampPlatformFields({ createdAt: original });
    expect(result.createdAt).toBe(original);
  });

  it("always refreshes updatedAt", () => {
    const original = new Date("2024-01-01T00:00:00Z");
    const result = stampPlatformFields({ updatedAt: original });
    expect(result.updatedAt).not.toBe(original);
    expect(result.updatedAt.getTime()).toBeGreaterThan(original.getTime());
  });

  it("preserves existing bundu fields and only adds missing ones", () => {
    const result = stampPlatformFields(
      { bundu: { countryCode: "TZ", verificationTier: 2, trustSignals: ["caretaker"] } },
      { countryCode: "ZW" },
    );
    // Existing countryCode kept, not overwritten
    expect(result.bundu.countryCode).toBe("TZ");
    expect((result.bundu as Record<string, unknown>).verificationTier).toBe(2);
    expect((result.bundu as Record<string, unknown>).trustSignals).toEqual(["caretaker"]);
  });

  it("mutates the input document in place", () => {
    const doc: Record<string, unknown> = { name: "test" };
    const result = stampPlatformFields(doc);
    expect(result).toBe(doc);
    expect(doc.name).toBe("test");
    expect(doc._schemaVersion).toBe("v3.1");
  });

  it("generates unique _id values across calls", () => {
    const a = stampPlatformFields({});
    const b = stampPlatformFields({});
    expect(a._id).not.toBe(b._id);
  });
});

describe("isIndexConflictError", () => {
  it("returns true for IndexOptionsConflict (85)", () => {
    expect(isIndexConflictError({ code: 85 })).toBe(true);
  });

  it("returns true for IndexKeySpecsConflict (86)", () => {
    expect(isIndexConflictError({ code: 86 })).toBe(true);
  });

  it("returns true for IndexAlreadyExists (68)", () => {
    expect(isIndexConflictError({ code: 68 })).toBe(true);
  });

  it("returns false for a duplicate-key error (11000)", () => {
    expect(isIndexConflictError({ code: 11000 })).toBe(false);
  });

  it("returns false for unrelated errors and non-error values", () => {
    expect(isIndexConflictError({ code: 1 })).toBe(false);
    expect(isIndexConflictError(new Error("boom"))).toBe(false);
    expect(isIndexConflictError(null)).toBe(false);
    expect(isIndexConflictError(undefined)).toBe(false);
    expect(isIndexConflictError("nope")).toBe(false);
  });
});
