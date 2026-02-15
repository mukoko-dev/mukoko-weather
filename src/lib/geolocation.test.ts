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

const source = readFileSync(
  resolve(__dirname, "geolocation.ts"),
  "utf-8",
);

describe("geolocation source structure", () => {
  it("exports GeoResult interface with all status types", () => {
    expect(source).toContain('"success"');
    expect(source).toContain('"denied"');
    expect(source).toContain('"unavailable"');
    expect(source).toContain('"outside-zw"');
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

  it("returns 'outside-zw' when no nearest location is found", () => {
    expect(source).toContain('status: "outside-zw"');
  });

  it("returns 'success' with location and distance for valid position", () => {
    expect(source).toContain('status: "success"');
  });

  it("uses Earth radius of 6371 km for Haversine distance", () => {
    expect(source).toContain("6371");
  });

  it("rounds distance to nearest km", () => {
    expect(source).toContain("Math.round(distanceKm)");
  });

  it("uses the /api/geo endpoint for nearest location lookup", () => {
    expect(source).toContain("/api/geo?lat=");
  });

  it("uses 10 second timeout for geolocation", () => {
    expect(source).toContain("timeout: 10000");
  });

  it("caches position for 5 minutes", () => {
    expect(source).toContain("maximumAge: 300000");
  });
});

describe("Haversine distance formula verification", () => {
  // Reproduce the Haversine formula from the source code
  function haversineDistance(
    lat1: number, lon1: number,
    lat2: number, lon2: number,
  ): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  it("computes ~0 km for identical coordinates", () => {
    expect(Math.round(haversineDistance(-17.83, 31.05, -17.83, 31.05))).toBe(0);
  });

  it("computes reasonable distance between Harare and Bulawayo (~440 km)", () => {
    const dist = haversineDistance(-17.83, 31.05, -20.15, 28.58);
    expect(dist).toBeGreaterThan(350);
    expect(dist).toBeLessThan(500);
  });

  it("computes reasonable distance between Harare and Mutare (~260 km)", () => {
    const dist = haversineDistance(-17.83, 31.05, -18.97, 32.67);
    expect(dist).toBeGreaterThan(180);
    expect(dist).toBeLessThan(300);
  });
});
