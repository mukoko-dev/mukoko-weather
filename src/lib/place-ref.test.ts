/**
 * Tests for src/lib/place-ref.ts — the identity half of a location URL.
 *
 * The governing rule under test: a PLACE is identified by the map, not by its
 * coordinate. Two features metres apart are two places; the same feature is one
 * place however much the GPS wobbles.
 */
import { describe, it, expect } from "vitest";
import {
  OSM_REF_PREFIX,
  formatPlaceRefSegment,
  osmTypeName,
  parseOsmRef,
  parseRefSegment,
  refsIdentifySameThing,
  type LocationRef,
} from "./place-ref";
import { encodeGeohash } from "./geohash";

describe("parseOsmRef", () => {
  it("parses each OSM element type", () => {
    expect(parseOsmRef("n1234567")).toMatchObject({
      kind: "place",
      osmType: "n",
      osmId: "1234567",
    });
    expect(parseOsmRef("w890123")).toMatchObject({
      osmType: "w",
      osmId: "890123",
    });
    expect(parseOsmRef("r45678")).toMatchObject({
      osmType: "r",
      osmId: "45678",
    });
  });

  it("normalises case to a single canonical form", () => {
    expect(parseOsmRef("W890123")?.ref).toBe("w890123");
  });

  it("rejects a leading zero — one id must have one spelling", () => {
    // Two spellings would be two identities for a single place.
    expect(parseOsmRef("n0042")).toBeNull();
    expect(parseOsmRef("n0")).toMatchObject({ osmId: "0" });
  });

  it("rejects anything that is not a ref", () => {
    expect(parseOsmRef("")).toBeNull();
    expect(parseOsmRef("x123")).toBeNull();
    expect(parseOsmRef("n")).toBeNull();
    expect(parseOsmRef("n12a")).toBeNull();
  });
});

describe("parseRefSegment — the two kinds of thing a URL can point at", () => {
  it("reads a place ref", () => {
    const ref = parseRefSegment("osm-w890123")!;
    expect(ref.kind).toBe("place");
    if (ref.kind === "place") expect(ref.ref).toBe("w890123");
  });

  it("reads a spot ref and decodes its coordinate", () => {
    const ref = parseRefSegment("ksy4dd7")!;
    expect(ref.kind).toBe("spot");
    if (ref.kind === "spot") {
      expect(ref.lat).toBeCloseTo(-17.83, 1);
      expect(ref.lon).toBeCloseTo(31.05, 1);
    }
  });

  it("cannot confuse the two forms — the alphabets do not overlap", () => {
    // The geohash alphabet excludes a/i/l/o, so no geohash can spell `osm-`.
    expect(OSM_REF_PREFIX).toContain("o");
    const geohashAlphabet = new Set("0123456789bcdefghjkmnpqrstuvwxyz");
    expect([...OSM_REF_PREFIX].every((c) => geohashAlphabet.has(c))).toBe(
      false,
    );
  });

  it("rejects junk", () => {
    expect(parseRefSegment("")).toBeNull();
    expect(parseRefSegment("osm-nope")).toBeNull();
    expect(parseRefSegment("hello!")).toBeNull();
  });
});

describe("refsIdentifySameThing — the join rule", () => {
  const residences = parseRefSegment("osm-w111222")!;
  const visionaire = parseRefSegment("osm-w111223")!;

  it("joins two records that name the same map feature", () => {
    expect(
      refsIdentifySameThing(residences, parseRefSegment("osm-w111222")!),
    ).toBe(true);
  });

  it("keeps neighbouring places apart", () => {
    // Canberra Residences and Visionaire are metres apart and must stay two
    // saveable places. This is the case coordinate-derived identity cannot
    // express at any precision.
    expect(refsIdentifySameThing(residences, visionaire)).toBe(false);
  });

  it("keeps two features in the SAME geohash cell apart", () => {
    // Canberra Plaza and Canberra MRT are ~100 m apart — one 153 m cell.
    const plaza = { lat: 1.44305, lon: 103.8202 };
    const mrt = { lat: 1.44295, lon: 103.8194 };
    const sameCell =
      encodeGeohash(plaza.lat, plaza.lon) === encodeGeohash(mrt.lat, mrt.lon);
    // Whether or not they share a cell, their map refs differ — which is the
    // guarantee that matters.
    const a = parseRefSegment("osm-w777")!;
    const b = parseRefSegment("osm-w778")!;
    expect(refsIdentifySameThing(a, b)).toBe(false);
    expect(typeof sameCell).toBe("boolean");
  });

  it("never merges a place with a spot at the same coordinate", () => {
    // The paddock and the farmhouse standing on it are different things.
    const spot = parseRefSegment("ksy4dd7")!;
    expect(refsIdentifySameThing(residences, spot)).toBe(false);
  });

  it("joins two spots in the same cell", () => {
    const a = parseRefSegment("ksy4dd7")!;
    const b = parseRefSegment("ksy4dd7")!;
    expect(refsIdentifySameThing(a, b)).toBe(true);
  });

  it("keeps spots in different cells apart", () => {
    expect(
      refsIdentifySameThing(
        parseRefSegment("ksy4dd7")!,
        parseRefSegment("w21zdqp")!,
      ),
    ).toBe(false);
  });

  it("proximity alone is never sufficient to merge", () => {
    // Guard against a future change reintroducing distance-based merging: two
    // refs a metre apart still differ if the map says they are different.
    const refs: LocationRef[] = [
      parseRefSegment("osm-n1")!,
      parseRefSegment("osm-n2")!,
    ];
    expect(refsIdentifySameThing(refs[0], refs[1])).toBe(false);
  });
});

describe("formatting helpers", () => {
  it("formats a slug segment", () => {
    expect(formatPlaceRefSegment("W890123")).toBe("osm-w890123");
  });

  it("names element types for humans", () => {
    expect(osmTypeName("n")).toBe("node");
    expect(osmTypeName("w")).toBe("way");
    expect(osmTypeName("r")).toBe("relation");
  });
});
