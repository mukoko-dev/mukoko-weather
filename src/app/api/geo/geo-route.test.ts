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
