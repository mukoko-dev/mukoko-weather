import { describe, expect, it } from "vitest";
import { LOCATIONS } from "./locations";
import {
  catalogueLocation,
  localPlaceForSlug,
  spotLocation,
} from "./local-place";
import { canonicalSlug } from "./slug-migration";
import { buildSmartSlug } from "./smart-slug";

describe("localPlaceForSlug: the places a slug names with no lookup", () => {
  it("is the shipped place itself, under its canonical slug, for every shipped slug (#317)", () => {
    for (const loc of LOCATIONS) {
      const canonical = canonicalSlug(loc.slug);
      expect(localPlaceForSlug(loc.slug), loc.slug).toEqual({
        ...loc,
        slug: canonical,
      });
      // The canonical slug is a spot by grammar, but names the seed: it is
      // the seed itself (its own province, tags and height), never a bare
      // coordinate.
      expect(localPlaceForSlug(canonical), canonical).toBe(
        localPlaceForSlug(loc.slug),
      );
    }
  });

  it("a canonical seed slug keeps the seed's own region, height and tags", () => {
    const place = localPlaceForSlug(canonicalSlug("bulawayo"))!;
    expect(place.province).toBe("Bulawayo");
    expect(place.tags).toContain("city");
    expect(place.regionApproximate).toBeUndefined();
    expect(place.elevationApproximate).toBeUndefined();
    expect(place.source).not.toBe("geolocation");
  });

  it("decodes a spot from its own slug: coordinate, name, no measured height", () => {
    const slug = buildSmartSlug("Koh Samui Beach", 9.5, 100.0)!;
    const spot = localPlaceForSlug(slug)!;
    expect(spot.slug).toBe(slug);
    expect(spot.name).toBe("Koh Samui Beach");
    expect(spot.lat).toBeCloseTo(9.5, 2);
    expect(spot.lon).toBeCloseTo(100.0, 2);
    expect(spot.elevationApproximate).toBe(true);
    expect(spot.source).toBe("geolocation");
  });

  it("lends a spot the nearest shipped place's region, marked approximate", () => {
    // About 12 km from Harare.
    const slug = buildSmartSlug("My Farm", -17.9, 31.1)!;
    const spot = localPlaceForSlug(slug)!;
    const harare = catalogueLocation("harare")!;
    expect(spot.country).toBe(harare.country);
    expect(spot.province).toBe(harare.province);
    expect(spot.regionApproximate).toBe(true);
    // The height stays a placeholder the forecast replaces.
    expect(spot.elevationApproximate).toBe(true);
  });

  it("lends nothing when no shipped place is within 250 km", () => {
    // Open ocean, far from every shipped place.
    const slug = buildSmartSlug("Mid Pacific", -30, -140)!;
    const spot = localPlaceForSlug(slug)!;
    expect(spot.country).toBeUndefined();
    expect(spot.province).toBe("");
    expect(spot.regionApproximate).toBeUndefined();
  });

  it("is null for anything only a lookup can name", () => {
    for (const slug of [
      "sembawang-sg", // a community place created through the platform
      "mcdonald-s--osm-n2420993462", // an OSM place reference
      "harare-a1b2c3", // a legacy platform slug
      "pricing",
      "zzzz-not-a-place",
      "",
    ]) {
      expect(localPlaceForSlug(slug), slug).toBeNull();
    }
  });

  it("never reads the network or a store (it is a pure function of the slug)", async () => {
    const source = (await import("fs")).readFileSync(
      new URL("./local-place.ts", import.meta.url),
      "utf-8",
    );
    expect(source).not.toMatch(/fetch\(|@\/lib\/db|\.\/db"|mongo|workerData/i);
  });

  it("spotLocation alone does not borrow a region (the in-app switch shows what the slug says)", () => {
    const slug = buildSmartSlug("My Farm", -17.9, 31.1)!;
    const spot = spotLocation(slug)!;
    expect(spot.country).toBeUndefined();
    expect(spot.regionApproximate).toBeUndefined();
  });
});
