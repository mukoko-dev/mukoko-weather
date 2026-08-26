/**
 * Tests for src/lib/geohash.ts.
 *
 * The encode cases are published reference values (Wikipedia / geohash.org),
 * not values this implementation produced — an implementation that agrees with
 * itself proves nothing about whether it agrees with the standard.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_GEOHASH_PRECISION,
  GEOHASH_CELL_METRES,
  decodeGeohash,
  encodeGeohash,
  geohashCommonPrefixLength,
  geohashNeighbors,
  isGeohash,
} from "./geohash";

describe("encodeGeohash — published reference values", () => {
  it.each([
    // Wikipedia's canonical worked example.
    { lat: 57.64911, lon: 10.40744, precision: 11, expected: "u4pruydqqvj" },
    // geohash.org examples.
    { lat: 42.6, lon: -5.6, precision: 5, expected: "ezs42" },
    { lat: 51.5074, lon: -0.1278, precision: 6, expected: "gcpvj0" },
    { lat: -33.8688, lon: 151.2093, precision: 6, expected: "r3gx2f" },
  ])(
    "encodes ($lat, $lon) at precision $precision to $expected",
    ({ lat, lon, precision, expected }) => {
      expect(encodeGeohash(lat, lon, precision)).toBe(expected);
    },
  );

  it("produces exactly `precision` characters", () => {
    for (let p = 1; p <= 9; p++) {
      expect(encodeGeohash(-17.8292, 31.0522, p)).toHaveLength(p);
    }
  });

  it("is deterministic — the same coordinate always yields the same slug", () => {
    // This is the property the old random hex suffix lacked: two independent
    // requests for one place converge instead of minting rival records.
    const a = encodeGeohash(-17.8292, 31.0522);
    const b = encodeGeohash(-17.8292, 31.0522);
    expect(a).toBe(b);
  });

  it("uses only the reduced alphabet (no a, i, l or o)", () => {
    for (const [lat, lon] of [
      [-17.8, 31.0],
      [1.35, 103.8],
      [51.5, -0.13],
      [-33.9, 151.2],
    ]) {
      expect(encodeGeohash(lat, lon, 9)).not.toMatch(/[ailo]/);
    }
  });

  it("returns empty string for unusable coordinates rather than throwing", () => {
    expect(encodeGeohash(Number.NaN, 0)).toBe("");
    expect(encodeGeohash(0, Number.POSITIVE_INFINITY)).toBe("");
    expect(encodeGeohash(91, 0)).toBe("");
    expect(encodeGeohash(0, 181)).toBe("");
  });

  it("handles the poles and the antimeridian", () => {
    expect(encodeGeohash(90, 180, 6)).toHaveLength(6);
    expect(encodeGeohash(-90, -180, 6)).toHaveLength(6);
    expect(encodeGeohash(0, 0, 6)).toHaveLength(6);
  });
});

describe("decodeGeohash", () => {
  it("decodes a published value to the expected coordinate", () => {
    const d = decodeGeohash("ezs42")!;
    expect(d.lat).toBeCloseTo(42.605, 2);
    expect(d.lon).toBeCloseTo(-5.603, 2);
  });

  it("round-trips real app coordinates within the cell's stated error", () => {
    for (const [lat, lon] of [
      [-17.8292, 31.0522],
      [1.3521, 103.8198],
      [-20.1594, 28.5886],
    ]) {
      const decoded = decodeGeohash(
        encodeGeohash(lat, lon, DEFAULT_GEOHASH_PRECISION),
      )!;
      // Original coordinate must lie inside the decoded cell.
      expect(lat).toBeGreaterThanOrEqual(decoded.bounds.latMin);
      expect(lat).toBeLessThanOrEqual(decoded.bounds.latMax);
      expect(lon).toBeGreaterThanOrEqual(decoded.bounds.lonMin);
      expect(lon).toBeLessThanOrEqual(decoded.bounds.lonMax);
    }
  });

  it("reports a tighter cell as precision grows", () => {
    let previous = Infinity;
    for (let p = 3; p <= 9; p++) {
      const { errorKm } = decodeGeohash(encodeGeohash(-17.8292, 31.0522, p))!;
      expect(errorKm).toBeLessThan(previous);
      previous = errorKm;
    }
  });

  it("puts default precision inside a ~150 m box", () => {
    const { errorKm } = decodeGeohash(encodeGeohash(-17.8292, 31.0522))!;
    expect(errorKm).toBeLessThan(0.15);
  });

  it("is case-insensitive", () => {
    expect(decodeGeohash("EZS42")!.lat).toBeCloseTo(
      decodeGeohash("ezs42")!.lat,
      6,
    );
  });

  it("returns null for anything that is not a geohash", () => {
    expect(decodeGeohash("")).toBeNull();
    expect(decodeGeohash("hello!")).toBeNull();
    // a, i, l, o are outside the alphabet.
    expect(decodeGeohash("aaa")).toBeNull();
    expect(decodeGeohash("harare")).toBeNull();
  });
});

describe("isGeohash", () => {
  it("accepts alphabet-valid strings and rejects the rest", () => {
    expect(isGeohash("ksy4dd7")).toBe(true);
    expect(isGeohash("gweru")).toBe(true); // A real town name that is also valid — see smart-slug.
    expect(isGeohash("harare")).toBe(false); // contains 'a'
    expect(isGeohash("")).toBe(false);
    expect(isGeohash("ab-cd")).toBe(false);
  });
});

describe("geohashNeighbors", () => {
  it("returns eight surrounding cells for an interior cell", () => {
    const neighbors = geohashNeighbors(encodeGeohash(-17.8292, 31.0522, 6));
    expect(neighbors).toHaveLength(8);
    expect(new Set(neighbors).size).toBe(8);
  });

  it("never includes the cell itself", () => {
    const hash = encodeGeohash(-17.8292, 31.0522, 6);
    expect(geohashNeighbors(hash)).not.toContain(hash);
  });

  it("returns adjacent cells — each shares a boundary with the original", () => {
    const hash = encodeGeohash(-17.8292, 31.0522, 5);
    const origin = decodeGeohash(hash)!;
    const latStep = origin.bounds.latMax - origin.bounds.latMin;
    const lonStep = origin.bounds.lonMax - origin.bounds.lonMin;
    for (const neighbor of geohashNeighbors(hash)) {
      const d = decodeGeohash(neighbor)!;
      expect(Math.abs(d.lat - origin.lat)).toBeLessThanOrEqual(latStep * 1.5);
      expect(Math.abs(d.lon - origin.lon)).toBeLessThanOrEqual(lonStep * 1.5);
    }
  });

  it("degrades gracefully at a pole — no cell exists beyond it", () => {
    const neighbors = geohashNeighbors(encodeGeohash(90, 0, 3));
    expect(neighbors.length).toBeGreaterThan(0);
    expect(neighbors.length).toBeLessThan(8);
  });

  it("wraps across the antimeridian instead of dropping cells", () => {
    expect(geohashNeighbors(encodeGeohash(0, 180, 3))).toHaveLength(8);
  });

  it("returns empty for an invalid geohash", () => {
    expect(geohashNeighbors("not-a-geohash")).toEqual([]);
  });
});

describe("geohashCommonPrefixLength", () => {
  it("grows for nearby coordinates", () => {
    const harare = encodeGeohash(-17.8292, 31.0522, 9);
    const nearby = encodeGeohash(-17.8295, 31.0525, 9);
    const faraway = encodeGeohash(1.3521, 103.8198, 9);
    expect(geohashCommonPrefixLength(harare, nearby)).toBeGreaterThan(
      geohashCommonPrefixLength(harare, faraway),
    );
  });

  it("is zero for unrelated hashes and full length for identical ones", () => {
    expect(geohashCommonPrefixLength("ksy4dd7", "w21zdqp")).toBe(0);
    expect(geohashCommonPrefixLength("ksy4dd7", "ksy4dd7")).toBe(7);
  });
});

describe("GEOHASH_CELL_METRES", () => {
  it("shrinks monotonically as precision increases", () => {
    const lengths = Object.keys(GEOHASH_CELL_METRES)
      .map(Number)
      .sort((a, b) => a - b);
    for (let i = 1; i < lengths.length; i++) {
      expect(GEOHASH_CELL_METRES[lengths[i]].width).toBeLessThan(
        GEOHASH_CELL_METRES[lengths[i - 1]].width,
      );
    }
  });

  it("covers the default precision", () => {
    expect(GEOHASH_CELL_METRES[DEFAULT_GEOHASH_PRECISION]).toBeDefined();
  });
});
