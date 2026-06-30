/**
 * Tests for src/lib/places.ts — the canonical Phase 0F location resolver
 * that reads from `places.placesGeo`.
 *
 * These are pure-logic tests that don't require a MongoDB connection.
 * The resolver/nearest/search helpers depend on the platform DB, which is
 * mocked out at the call boundary by the integration tests elsewhere.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeName,
  inferNameFromSlug,
  adaptPlacesGeoToLocationDoc,
  listSeedLocations,
  type PlacesGeoDoc,
} from "./places";
import { LOCATIONS } from "./locations";

describe("normalizeName", () => {
  it("lowercases and trims", () => {
    expect(normalizeName("  Harare  ")).toBe("harare");
    expect(normalizeName("HARARE")).toBe("harare");
  });

  it("strips diacritics", () => {
    expect(normalizeName("São Paulo")).toBe("sao paulo");
    expect(normalizeName("Côte d'Ivoire")).toBe("cote d'ivoire");
  });

  it("collapses whitespace", () => {
    expect(normalizeName("Victoria    Falls")).toBe("victoria falls");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeName("")).toBe("");
  });
});

describe("inferNameFromSlug", () => {
  it("title-cases simple slugs", () => {
    expect(inferNameFromSlug("harare")).toBe("Harare");
  });

  it("splits hyphenated slugs", () => {
    expect(inferNameFromSlug("victoria-falls")).toBe("Victoria Falls");
  });

  it("strips trailing 2-letter country code", () => {
    expect(inferNameFromSlug("nairobi-ke")).toBe("Nairobi");
    expect(inferNameFromSlug("bangkok-th")).toBe("Bangkok");
  });

  it("does not strip non-country trailing parts", () => {
    expect(inferNameFromSlug("victoria-falls")).toBe("Victoria Falls");
  });

  it("returns empty for empty input", () => {
    expect(inferNameFromSlug("")).toBe("");
  });
});

describe("adaptPlacesGeoToLocationDoc", () => {
  const baseDoc: PlacesGeoDoc = {
    _id: "test-placegeo-id",
    name: "Harare",
    slug: "harare-a1b2c3",
    geoType: "city",
    geo: { type: "Point", coordinates: [31.05, -17.83] }, // [lon, lat]
    sourceProvenance: {
      dataOrigin: "mukoko_user",
      dataConfidence: 0.9,
    },
  };

  it("preserves the requested clean slug (not the platform hash-suffixed slug)", async () => {
    const adapted = await adaptPlacesGeoToLocationDoc(baseDoc, {
      cleanSlug: "harare",
    });
    expect(adapted.slug).toBe("harare");
    expect(adapted.platformSlug).toBe("harare-a1b2c3");
  });

  it("maps GeoJSON [lon, lat] to lat/lon fields", async () => {
    const adapted = await adaptPlacesGeoToLocationDoc(baseDoc, {
      cleanSlug: "harare",
    });
    expect(adapted.lat).toBeCloseTo(-17.83);
    expect(adapted.lon).toBeCloseTo(31.05);
  });

  it("preserves the platform _id", async () => {
    const adapted = await adaptPlacesGeoToLocationDoc(baseDoc, {
      cleanSlug: "harare",
    });
    expect(adapted._id).toBe("test-placegeo-id");
  });

  it("uses sourceProvenance.mukokoProvince/mukokoElevation when present", async () => {
    const adapted = await adaptPlacesGeoToLocationDoc(
      {
        ...baseDoc,
        sourceProvenance: {
          ...baseDoc.sourceProvenance,
          mukokoProvince: "Harare Metro",
          mukokoElevation: 1490,
          mukokoTags: ["city", "education"],
        },
      },
      { cleanSlug: "harare" },
    );
    expect(adapted.province).toBe("Harare Metro");
    expect(adapted.elevation).toBe(1490);
    expect(adapted.tags).toEqual(["city", "education"]);
  });

  it("falls back to the static seed for tags/province/elevation when placesGeo lacks them", async () => {
    const seed = LOCATIONS.find((l) => l.slug === "harare");
    expect(seed).toBeDefined();
    const adapted = await adaptPlacesGeoToLocationDoc(baseDoc, {
      cleanSlug: "harare",
      seed,
    });
    expect(adapted.province).toBe(seed!.province);
    expect(adapted.elevation).toBe(seed!.elevation);
    expect(adapted.tags).toEqual(seed!.tags);
  });

  it("defaults tags to ['city'] when neither placesGeo nor seed provides them", async () => {
    const adapted = await adaptPlacesGeoToLocationDoc(baseDoc, {
      cleanSlug: "some-new-place",
    });
    expect(adapted.tags).toEqual(["city"]);
  });
});

describe("listSeedLocations (static catalog still ships in code)", () => {
  it("returns the static LOCATIONS array unchanged", () => {
    expect(listSeedLocations()).toBe(LOCATIONS);
    expect(listSeedLocations().length).toBeGreaterThan(0);
  });
});

describe("dedup discipline (Phase 0E carry-forward)", () => {
  it("seed slugs are globally unique — no `-2` / `-3` collisions ever", () => {
    const slugs = LOCATIONS.map((l) => l.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).not.toMatch(/-\d+$/);
    }
  });
});
