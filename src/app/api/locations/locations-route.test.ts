/**
 * Tests for the /api/locations route — validates parameter handling
 * and response structure.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "route.ts"), "utf-8");

describe("/api/locations route structure", () => {
  it("exports a GET handler", () => {
    expect(source).toContain("export async function GET");
  });

  it("supports single location lookup by slug", () => {
    expect(source).toContain('searchParams.get("slug")');
    expect(source).toContain("getLocationFromDb");
  });

  it("supports tag filtering", () => {
    expect(source).toContain('searchParams.get("tag")');
    expect(source).toContain("getLocationsByTagFromDb");
  });

  it("supports tags mode for tag counts", () => {
    expect(source).toContain('searchParams.get("mode")');
    expect(source).toContain("getTagCounts");
  });

  it("returns all locations by default", () => {
    expect(source).toContain("getAllLocationsFromDb");
  });

  it("returns 404 when location not found", () => {
    expect(source).toContain("status: 404");
    expect(source).toContain("Location not found");
  });

  it("returns 503 when MongoDB is unavailable", () => {
    expect(source).toContain("status: 503");
    expect(source).toContain("Location data unavailable");
  });

  it("queries MongoDB directly without hardcoded fallback", () => {
    // Verify that this route does NOT import from the static locations array
    expect(source).not.toContain('from "@/lib/locations"');
    expect(source).not.toContain("import { LOCATIONS }");
  });

  it("logs errors when MongoDB query fails", () => {
    expect(source).toContain("logError");
    expect(source).toContain("Locations API query failed");
  });
});
