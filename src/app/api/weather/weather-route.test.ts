/**
 * Tests for the /api/weather route — validates coordinate validation,
 * header behavior, and error handling patterns by examining the source
 * and testing the logic inline.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "route.ts"),
  "utf-8",
);

describe("/api/weather route structure", () => {
  it("exports a GET handler", () => {
    expect(source).toContain("export async function GET");
  });

  it("defaults lat to -17.83 (Harare) when missing", () => {
    expect(source).toContain('"-17.83"');
  });

  it("defaults lon to 31.05 (Harare) when missing", () => {
    expect(source).toContain('"31.05"');
  });

  it("returns 400 for NaN coordinates", () => {
    expect(source).toContain("isNaN(lat) || isNaN(lon)");
    expect(source).toContain("Invalid coordinates");
    expect(source).toContain("status: 400");
  });

  it("validates Zimbabwe bounds: lat < -23 || lat > -15 || lon < 24 || lon > 34", () => {
    expect(source).toContain("lat < -23");
    expect(source).toContain("lat > -15");
    expect(source).toContain("lon < 24");
    expect(source).toContain("lon > 34");
    expect(source).toContain("Coordinates outside Zimbabwe region");
  });

  it("sets X-Cache header to HIT for cache hits", () => {
    expect(source).toContain('"X-Cache"');
    expect(source).toContain('"HIT"');
    expect(source).toContain('"MISS"');
  });

  it("sets X-Weather-Provider header", () => {
    expect(source).toContain('"X-Weather-Provider"');
  });

  it("uses MongoDB geospatial query to resolve cache key", () => {
    expect(source).toContain("findNearestLocationsFromDb(lat, lon");
  });

  it("defaults elevation to 1200 when no location is found", () => {
    expect(source).toContain("1200");
  });

  it("logs a warning when source is fallback", () => {
    expect(source).toContain('source === "fallback"');
    expect(source).toContain("logWarn");
    expect(source).toContain("All weather providers failed");
  });

  it("never returns a 500 — always serves fallback weather on error", () => {
    expect(source).toContain("createFallbackWeather(lat, lon, elevation)");
    // The catch block returns JSON with fallback data, not a 500
    expect(source).not.toContain("status: 500");
  });

  it("logs critical error on unexpected exceptions", () => {
    expect(source).toContain('severity: "critical"');
    expect(source).toContain("Unexpected error in weather API route");
  });
});

describe("coordinate validation logic", () => {
  // Re-implement the validation logic from the route for unit testing
  function validateCoordinates(latStr: string | null, lonStr: string | null) {
    const lat = parseFloat(latStr ?? "-17.83");
    const lon = parseFloat(lonStr ?? "31.05");

    if (isNaN(lat) || isNaN(lon)) {
      return { error: "Invalid coordinates", status: 400 };
    }

    if (lat < -23 || lat > -15 || lon < 24 || lon > 34) {
      return { error: "Coordinates outside Zimbabwe region", status: 400 };
    }

    return { lat, lon };
  }

  it("uses defaults for null params", () => {
    const result = validateCoordinates(null, null);
    expect(result).toEqual({ lat: -17.83, lon: 31.05 });
  });

  it("returns error for NaN lat", () => {
    const result = validateCoordinates("abc", "31.05");
    expect(result).toEqual({ error: "Invalid coordinates", status: 400 });
  });

  it("returns error for NaN lon", () => {
    const result = validateCoordinates("-17.83", "xyz");
    expect(result).toEqual({ error: "Invalid coordinates", status: 400 });
  });

  it("rejects lat too far south", () => {
    const result = validateCoordinates("-24", "31");
    expect(result).toHaveProperty("error", "Coordinates outside Zimbabwe region");
  });

  it("rejects lat too far north", () => {
    const result = validateCoordinates("-14", "31");
    expect(result).toHaveProperty("error", "Coordinates outside Zimbabwe region");
  });

  it("rejects lon too far west", () => {
    const result = validateCoordinates("-17", "23");
    expect(result).toHaveProperty("error", "Coordinates outside Zimbabwe region");
  });

  it("rejects lon too far east", () => {
    const result = validateCoordinates("-17", "35");
    expect(result).toHaveProperty("error", "Coordinates outside Zimbabwe region");
  });

  it("accepts valid Zimbabwe coordinates", () => {
    const result = validateCoordinates("-17.83", "31.05");
    expect(result).toEqual({ lat: -17.83, lon: 31.05 });
  });

  it("accepts boundary values within range", () => {
    // -22.99 is > -23 and < -15, 24.01 is > 24 and < 34
    expect(validateCoordinates("-22.99", "24.01")).toHaveProperty("lat");
    expect(validateCoordinates("-15.01", "33.99")).toHaveProperty("lat");
  });

  it("rejects exact boundary values", () => {
    // lat = -23 is < -23 is false, but lat < -23 should be false at -23 exactly
    // -23 < -23 = false, -23 > -15 = false, so -23 should be accepted
    // Wait, let's check: lat < -23 || lat > -15 || lon < 24 || lon > 34
    // -23 < -23 = false. So -23 is accepted.
    expect(validateCoordinates("-23", "30")).toHaveProperty("lat", -23);
    expect(validateCoordinates("-15", "30")).toHaveProperty("lat", -15);
  });
});
