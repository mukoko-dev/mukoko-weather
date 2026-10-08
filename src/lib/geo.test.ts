import { describe, it, expect } from "vitest";
import { haversineKm, nearestWithin } from "./geo";

const HARARE = { lat: -17.8292, lon: 31.0522 };
const BULAWAYO = { lat: -20.1325, lon: 28.6265 };

describe("haversineKm", () => {
  it("is zero for identical points", () => {
    expect(haversineKm(HARARE.lat, HARARE.lon, HARARE.lat, HARARE.lon)).toBe(0);
  });

  it("matches the Harare-Bulawayo great-circle distance (~361 km)", () => {
    const km = haversineKm(HARARE.lat, HARARE.lon, BULAWAYO.lat, BULAWAYO.lon);
    expect(km).toBeGreaterThan(358);
    expect(km).toBeLessThan(364);
  });

  it("is symmetric", () => {
    const ab = haversineKm(HARARE.lat, HARARE.lon, BULAWAYO.lat, BULAWAYO.lon);
    const ba = haversineKm(BULAWAYO.lat, BULAWAYO.lon, HARARE.lat, HARARE.lon);
    expect(ab).toBeCloseTo(ba, 9);
  });

  it("gives one degree of longitude on the equator as ~111.19 km", () => {
    expect(haversineKm(0, 0, 0, 1)).toBeCloseTo(111.195, 2);
  });

  it("gives London-Paris as ~343.6 km", () => {
    expect(haversineKm(51.5074, -0.1278, 48.8566, 2.3522)).toBeCloseTo(
      343.56,
      1,
    );
  });
});

describe("nearestWithin", () => {
  const points = [
    { id: "harare", lat: -17.8292, lon: 31.0522 },
    { id: "bulawayo", lat: -20.1325, lon: 28.6265 },
    { id: "mutare", lat: -18.9707, lon: 32.6709 },
  ];
  const at = (p: { lat: number; lon: number }) => p;

  it("sorts nearest first", () => {
    const result = nearestWithin(points, at, HARARE.lat, HARARE.lon);
    expect(result.map((m) => m.item.id)).toEqual([
      "harare",
      "mutare",
      "bulawayo",
    ]);
    expect(result[0].distanceKm).toBeCloseTo(0, 9);
  });

  it("limits to count", () => {
    const result = nearestWithin(
      points,
      at,
      HARARE.lat,
      HARARE.lon,
      Infinity,
      1,
    );
    expect(result).toHaveLength(1);
    expect(result[0].item.id).toBe("harare");
  });

  it("drops items beyond maxKm (inclusive boundary)", () => {
    const bulawayoKm = haversineKm(
      HARARE.lat,
      HARARE.lon,
      BULAWAYO.lat,
      BULAWAYO.lon,
    );
    const within = nearestWithin(
      points,
      at,
      HARARE.lat,
      HARARE.lon,
      bulawayoKm,
    );
    expect(within.map((m) => m.item.id)).toContain("bulawayo");
    const tight = nearestWithin(
      points,
      at,
      HARARE.lat,
      HARARE.lon,
      bulawayoKm - 1,
    );
    expect(tight.map((m) => m.item.id)).not.toContain("bulawayo");
  });

  it("returns an empty list when nothing is in range", () => {
    expect(nearestWithin(points, at, 51.5, -0.1, 100)).toEqual([]);
  });

  it("keeps the input order for exact ties", () => {
    const twins = [
      { id: "first", lat: 1, lon: 1 },
      { id: "second", lat: 1, lon: 1 },
    ];
    const result = nearestWithin(twins, at, 1, 1, Infinity, 2);
    expect(result.map((m) => m.item.id)).toEqual(["first", "second"]);
  });
});
