import { describe, it, expect } from "vitest";
import { getTtlForLocation, isSummaryStale, type AISummaryDoc } from "./db";

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
