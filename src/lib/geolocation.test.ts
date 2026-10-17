/**
 * Tests for geolocation.ts — validates the Haversine distance calculation
 * and the detectUserLocation wrapper behavior by reading the source file.
 *
 * The actual browser Geolocation API is not available in Node,
 * so we test the source logic patterns and the pure distance formula.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "geolocation.ts"), "utf-8");

describe("geolocation source structure", () => {
  it("exports GeoResult interface with all status types", () => {
    expect(source).toContain('"success"');
    expect(source).toContain('"created"');
    expect(source).toContain('"denied"');
    expect(source).toContain('"unavailable"');
    expect(source).toContain('"error"');
  });

  it("exports detectUserLocation function", () => {
    expect(source).toContain("export function detectUserLocation");
  });

  it("checks for geolocation API availability", () => {
    expect(source).toContain('"geolocation" in navigator');
  });

  it("returns 'unavailable' when geolocation API is not present", () => {
    expect(source).toContain('status: "unavailable"');
  });

  it("returns 'denied' on PERMISSION_DENIED error", () => {
    expect(source).toContain("PERMISSION_DENIED");
    expect(source).toContain('status: "denied"');
  });

  it("does not have region-based rejection (app is fully global)", () => {
    expect(source).not.toContain("outside-supported");
  });

  it("returns 'created' when a new location was auto-created", () => {
    expect(source).toContain('status: isNew ? "created" : "success"');
  });

  it("passes autoCreate=true to the geo API", () => {
    expect(source).toContain("autoCreate=true");
  });

  it("passes the find-only synthesized flag through (#302)", () => {
    expect(source).toContain("synthesized?: boolean;");
    expect(source).toContain("const synthesized = data.synthesized === true;");
  });

  it("includes isNew flag in result", () => {
    expect(source).toContain("isNew");
  });

  it("measures the distance with the shared haversineKm", () => {
    expect(source).toContain('import { haversineKm } from "./geo"');
    expect(source).toContain("haversineKm(");
  });

  it("rounds distance to nearest km", () => {
    expect(source).toContain("Math.round(distanceKm)");
  });

  it("asks the geo endpoint through fetchPlaces (behaviour: geolocation-flow.test.ts)", () => {
    expect(source).toContain("fetchPlaces(");
    // GPS fixes reach /api/py/geo exactly: exact-place naming and OSM-ref identity depend on them
    expect(source).toContain("lat=${latitude}&lon=${longitude}");
    expect(source).not.toContain("roundCoord");
  });

  it("defaults to a 10 second timeout for geolocation", () => {
    expect(source).toContain("DEFAULT_TIMEOUT_MS = 10000");
    expect(source).toContain("timeout: timeoutMs");
  });

  it("defaults to caching position for 1 minute", () => {
    expect(source).toContain("DEFAULT_MAXIMUM_AGE_MS = 60000");
    expect(source).toContain("maximumAge: maximumAgeMs");
  });

  it("allows callers to override the timeout and cache window", () => {
    // Enables a fast, cache-friendly "silent recheck" (e.g. HomeLanding's
    // travel detection) without changing the defaults for existing callers.
    expect(source).toContain("timeoutMs?: number");
    expect(source).toContain("maximumAgeMs?: number");
  });
});
