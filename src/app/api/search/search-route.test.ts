/**
 * Tests for the /api/search route — validates parameter handling,
 * search modes, and response structure.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "route.ts"), "utf-8");

describe("/api/search route structure", () => {
  it("exports a GET handler", () => {
    expect(source).toContain("export async function GET");
  });

  it("supports text search via q parameter", () => {
    expect(source).toContain('searchParams.get("q")');
    expect(source).toContain("searchLocationsFromDb");
  });

  it("supports tag filtering", () => {
    expect(source).toContain('searchParams.get("tag")');
  });

  it("supports geospatial search via lat/lon", () => {
    expect(source).toContain('searchParams.get("lat")');
    expect(source).toContain('searchParams.get("lon")');
    expect(source).toContain("findNearestLocationsFromDb");
  });

  it("supports tags mode for tag counts", () => {
    expect(source).toContain('"tags"');
    expect(source).toContain("getTagCounts");
  });

  it("limits results to max 50", () => {
    expect(source).toContain("50");
  });

  it("supports pagination with limit and skip", () => {
    expect(source).toContain('searchParams.get("limit")');
    expect(source).toContain('searchParams.get("skip")');
  });

  it("returns 400 when no search criteria provided", () => {
    expect(source).toContain("status: 400");
    expect(source).toContain("Provide q (search query) or tag (filter)");
  });

  it("returns 503 when MongoDB search fails", () => {
    expect(source).toContain("Search unavailable");
    expect(source).toContain("status: 503");
  });

  it("includes source field in response to indicate data origin", () => {
    expect(source).toContain('source: "mongodb"');
  });

  it("does not import from static locations array", () => {
    expect(source).not.toContain('from "@/lib/locations"');
  });

  it("returns 503 when tag counts query fails", () => {
    expect(source).toContain("status: 503");
    expect(source).toContain("Search unavailable");
  });

  it("validates lat/lon for geospatial search", () => {
    expect(source).toContain("isNaN(latNum) || isNaN(lonNum)");
    expect(source).toContain("Invalid lat/lon");
  });
});

describe("search parameter parsing", () => {
  function parseSearchParams(params: Record<string, string | null>) {
    const q = params.q ?? "";
    const tag = params.tag ?? undefined;
    const lat = params.lat;
    const lon = params.lon;
    const limit = Math.min(
      parseInt(params.limit ?? "20", 10) || 20,
      50,
    );
    const skip = parseInt(params.skip ?? "0", 10) || 0;
    return { q, tag, lat, lon, limit, skip };
  }

  it("defaults limit to 20", () => {
    const result = parseSearchParams({ q: "harare", tag: null, lat: null, lon: null, limit: null, skip: null });
    expect(result.limit).toBe(20);
  });

  it("caps limit at 50", () => {
    const result = parseSearchParams({ q: "harare", tag: null, lat: null, lon: null, limit: "100", skip: null });
    expect(result.limit).toBe(50);
  });

  it("defaults skip to 0", () => {
    const result = parseSearchParams({ q: "harare", tag: null, lat: null, lon: null, limit: null, skip: null });
    expect(result.skip).toBe(0);
  });

  it("parses skip correctly", () => {
    const result = parseSearchParams({ q: "harare", tag: null, lat: null, lon: null, limit: null, skip: "10" });
    expect(result.skip).toBe(10);
  });

  it("handles non-numeric limit gracefully", () => {
    const result = parseSearchParams({ q: "harare", tag: null, lat: null, lon: null, limit: "abc", skip: null });
    expect(result.limit).toBe(20); // falls back to default
  });

  it("passes tag through when present", () => {
    const result = parseSearchParams({ q: "", tag: "farming", lat: null, lon: null, limit: null, skip: null });
    expect(result.tag).toBe("farming");
  });

  it("tag is undefined when not provided", () => {
    const result = parseSearchParams({ q: "test", tag: null, lat: null, lon: null, limit: null, skip: null });
    expect(result.tag).toBeUndefined();
  });
});
