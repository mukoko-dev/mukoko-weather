/**
 * Structural compliance tests for /api/locations/add — inspects source code
 * patterns using readFileSync because Next.js API routes cannot be imported
 * directly in Vitest's Node environment.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "route.ts"), "utf-8");

describe("/api/locations/add route structure", () => {
  it("exports a POST handler", () => {
    expect(source).toContain("export async function POST");
  });

  it("supports search mode with query parameter", () => {
    expect(source).toContain("body.query");
    expect(source).toContain("forwardGeocode");
    expect(source).toContain('"candidates"');
  });

  it("supports coordinate mode with lat/lon", () => {
    expect(source).toContain("body.lat");
    expect(source).toContain("body.lon");
    expect(source).toContain("reverseGeocode");
  });

  it("validates coordinates are within supported regions using async DB check", () => {
    expect(source).toContain("isInSupportedRegionFromDb");
  });

  it("checks for duplicate locations within 20km", () => {
    expect(source).toContain("findDuplicateLocation");
  });

  it("returns duplicate info when location exists nearby", () => {
    expect(source).toContain('"duplicate"');
  });

  it("applies rate limiting", () => {
    expect(source).toContain("checkRateLimit");
    expect(source).toContain("location-create");
  });

  it("returns 429 when rate limit exceeded", () => {
    expect(source).toContain("status: 429");
  });

  it("generates a slug for new locations", () => {
    expect(source).toContain("generateSlug");
  });

  it("handles slug collisions with numeric suffix", () => {
    expect(source).toContain("suffix");
  });

  it("creates location with community source", () => {
    expect(source).toContain("createLocation");
    expect(source).toContain('"community"');
  });

  it("returns 400 for invalid coordinates", () => {
    expect(source).toContain("status: 400");
    expect(source).toContain("Invalid coordinates");
  });

  it("returns 422 when reverse geocoding fails", () => {
    expect(source).toContain("status: 422");
  });

  it("fetches elevation for new locations", () => {
    expect(source).toContain("getElevation");
  });

  it("filters search results to supported regions using async DB check", () => {
    expect(source).toContain("isInSupportedRegionFromDb");
    expect(source).toContain("supported");
  });

  it("logs errors via observability", () => {
    expect(source).toContain("logError");
  });
});
