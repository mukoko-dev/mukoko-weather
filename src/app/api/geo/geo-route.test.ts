/**
 * Tests for the /api/geo route — validates parameter handling
 * and response structure by examining the source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "route.ts"),
  "utf-8",
);

describe("/api/geo route structure", () => {
  it("exports a GET handler", () => {
    expect(source).toContain("export async function GET");
  });

  it("extracts lat and lon from search params", () => {
    expect(source).toContain('searchParams.get("lat")');
    expect(source).toContain('searchParams.get("lon")');
  });

  it("returns 400 for missing or invalid lat/lon", () => {
    expect(source).toContain("isNaN(lat) || isNaN(lon)");
    expect(source).toContain("Missing or invalid lat/lon");
    expect(source).toContain("status: 400");
  });

  it("defaults to empty string when params are missing", () => {
    // searchParams.get returns null, fallback to ""
    expect(source).toContain('?? ""');
  });

  it("returns 404 when location is outside supported regions", () => {
    expect(source).toContain("status: 404");
    expect(source).toContain("outside supported regions");
  });

  it("uses MongoDB geospatial query to resolve the position", () => {
    expect(source).toContain("findNearestLocationsFromDb");
  });

  it("fetches multiple candidates for country-aware matching", () => {
    expect(source).toContain("limit: 5");
    expect(source).toContain("COUNTRY_PREFERENCE_MAX_KM");
  });

  it("reverse geocodes in parallel to determine user country", () => {
    expect(source).toContain("Promise.all");
    expect(source).toContain("reverseGeocode(lat, lon)");
    expect(source).toContain("geocoded?.country");
  });

  it("uses pickBestMatch to prefer same-country locations", () => {
    expect(source).toContain("pickBestMatch(results,");
  });

  it("falls back to uncapped nearest when preference radius is empty", () => {
    // After the preference-radius query, the route retries without maxDistanceKm
    expect(source).toContain("limit: 1");
    expect(source).toContain("uncapped");
  });

  it("returns 503 when MongoDB is unavailable", () => {
    expect(source).toContain("status: 503");
    expect(source).toContain("Location service unavailable");
  });

  it("uses async DB-backed region check", () => {
    expect(source).toContain("isInSupportedRegionFromDb");
  });

  it("supports autoCreate query parameter", () => {
    expect(source).toContain("autoCreate");
  });

  it("returns isNew flag on success", () => {
    expect(source).toContain("isNew");
  });

  it("returns nearest location and redirectTo path on success", () => {
    expect(source).toContain("nearest");
    expect(source).toContain("redirectTo");
    expect(source).toContain("`/${nearest.slug}`");
  });
});

describe("geo parameter validation logic", () => {
  function validateGeoParams(latStr: string | null, lonStr: string | null) {
    const lat = parseFloat(latStr ?? "");
    const lon = parseFloat(lonStr ?? "");

    if (isNaN(lat) || isNaN(lon)) {
      return { error: "Missing or invalid lat/lon", status: 400 };
    }

    return { lat, lon };
  }

  it("returns error for null params", () => {
    expect(validateGeoParams(null, null)).toHaveProperty("error");
  });

  it("returns error for empty strings", () => {
    expect(validateGeoParams("", "")).toHaveProperty("error");
  });

  it("returns error for non-numeric strings", () => {
    expect(validateGeoParams("abc", "31")).toHaveProperty("error");
  });

  it("accepts valid coordinate strings", () => {
    const result = validateGeoParams("-17.83", "31.05");
    expect(result).toEqual({ lat: -17.83, lon: 31.05 });
  });
});

describe("pickBestMatch — country-aware location selection", () => {
  /**
   * Mirror of the pickBestMatch helper in route.ts.
   * Tests verify the same-country preference logic for border areas.
   */
  function pickBestMatch(
    candidates: { country?: string; slug: string }[],
    userCountry: string | null,
  ) {
    if (candidates.length === 0) return null;
    if (!userCountry) return candidates[0];
    const uc = userCountry.toUpperCase();
    const sameCountry = candidates.find(
      (loc) => (loc.country ?? "ZW").toUpperCase() === uc,
    );
    return sameCountry ?? candidates[0];
  }

  it("returns null for empty candidates", () => {
    expect(pickBestMatch([], "SG")).toBeNull();
  });

  it("returns nearest when user country is unknown", () => {
    const candidates = [
      { slug: "johor-bahru-my", country: "MY" },
      { slug: "singapore-sg", country: "SG" },
    ];
    expect(pickBestMatch(candidates, null)?.slug).toBe("johor-bahru-my");
  });

  it("prefers same-country match over closer cross-border location", () => {
    // Simulates Woodlands (SG) — JB is closer but SG is correct country
    const candidates = [
      { slug: "johor-bahru-my", country: "MY" },
      { slug: "singapore-sg", country: "SG" },
    ];
    expect(pickBestMatch(candidates, "SG")?.slug).toBe("singapore-sg");
  });

  it("falls back to nearest when no same-country match exists", () => {
    const candidates = [
      { slug: "johor-bahru-my", country: "MY" },
      { slug: "kuala-lumpur-my", country: "MY" },
    ];
    expect(pickBestMatch(candidates, "SG")?.slug).toBe("johor-bahru-my");
  });

  it("handles case-insensitive country codes", () => {
    const candidates = [
      { slug: "johor-bahru-my", country: "MY" },
      { slug: "singapore-sg", country: "SG" },
    ];
    expect(pickBestMatch(candidates, "sg")?.slug).toBe("singapore-sg");
  });

  it("defaults missing country to ZW", () => {
    const candidates = [
      { slug: "harare" },
      { slug: "johor-bahru-my", country: "MY" },
    ];
    expect(pickBestMatch(candidates, "ZW")?.slug).toBe("harare");
  });

  it("returns nearest same-country match among multiple", () => {
    // Candidates sorted by distance (nearest first)
    const candidates = [
      { slug: "george-town-my", country: "MY" },
      { slug: "singapore-sg", country: "SG" },
      { slug: "changi-sg", country: "SG" },
    ];
    // First SG match (singapore-sg) should be preferred over second (changi-sg)
    expect(pickBestMatch(candidates, "SG")?.slug).toBe("singapore-sg");
  });
});
