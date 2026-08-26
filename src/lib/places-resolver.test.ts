/**
 * Tests for `resolveLocationSlug` — the render path behind every `/{slug}`
 * weather page.
 *
 * These live in their own file because they mock the `placesGeo` collection at
 * the `./db` boundary, which the pure-logic tests in `places.test.ts`
 * deliberately avoid.
 *
 * The invariant under test: a slug the app SHIPS and ADVERTISES (sitemap,
 * /explore, search, the 404 page's own suggestions) must never 404, whatever
 * `places.placesGeo` happens to contain. Before this, the two sources could
 * disagree — the catalog offered 265 slugs while only those with a matching
 * placesGeo city/town/village document could render, so browsing or searching
 * to a location returned "Location not found".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** Mutable stand-in for the placesGeo collection, swapped per test. */
let findOneImpl: (filter: unknown) => Promise<unknown>;
let findArrayImpl: () => Promise<unknown[]>;

vi.mock("./db", () => ({
  placesGeoCollection: () => ({
    findOne: (filter: unknown) => findOneImpl(filter),
    find: () => ({
      limit: () => ({ toArray: () => findArrayImpl() }),
      // `ensureCountryCache` iterates a cursor directly.
      [Symbol.asyncIterator]: async function* () {},
    }),
  }),
  placesCollection: () => ({}),
}));

const { resolveLocationSlug } = await import("./places");

describe("resolveLocationSlug — seed fallback", () => {
  beforeEach(() => {
    findOneImpl = async () => null;
    findArrayImpl = async () => [];
  });

  it("renders a shipped slug when placesGeo has NO matching document", async () => {
    const loc = await resolveLocationSlug("singapore-sg");
    expect(loc).not.toBeNull();
    expect(loc?.name).toBe("Singapore");
    expect(loc?.slug).toBe("singapore-sg");
    // Real coordinates, so the weather fetch downstream actually works.
    expect(loc?.lat).toBeCloseTo(1.35, 1);
    expect(loc?.lon).toBeCloseTo(103.82, 1);
  });

  it("renders a shipped ZW slug when placesGeo has no matching document", async () => {
    const loc = await resolveLocationSlug("harare");
    expect(loc?.name).toBe("Harare");
    expect(loc?.country).toBe("ZW");
  });

  it("renders a shipped slug when the placesGeo lookup THROWS (DB outage)", async () => {
    // A transient Mongo failure used to surface as a permanent
    // "Location not found" — an outage must degrade, not 404.
    findOneImpl = async () => {
      throw new Error("connection timed out");
    };
    findArrayImpl = async () => {
      throw new Error("connection timed out");
    };
    const loc = await resolveLocationSlug("bulawayo");
    expect(loc?.name).toBe("Bulawayo");
  });

  it("still returns null for a slug the app does NOT ship", async () => {
    // Genuine 404s must stay 404s — the fallback is scoped to the catalog.
    expect(await resolveLocationSlug("not-a-real-place-xyz")).toBeNull();
    expect(await resolveLocationSlug("")).toBeNull();
  });

  it("prefers a real placesGeo document over the seed when one exists", async () => {
    findOneImpl = async () => ({
      _id: "platform-uuid",
      name: "Harare",
      slug: "harare-a1b2c3",
      geoType: "city",
      geo: { type: "Point", coordinates: [31.05, -17.83] },
      isoCode: "ZW",
      sourceProvenance: {
        mukokoSlug: "harare",
        mukokoProvince: "Harare Metropolitan",
      },
    });
    const loc = await resolveLocationSlug("harare");
    expect(loc?._id).toBe("platform-uuid");
    expect(loc?.platformSlug).toBe("harare-a1b2c3");
    expect(loc?.province).toBe("Harare Metropolitan");
  });

  it("accepts a country-level document for a city-state whose seed name matches", async () => {
    // Singapore exists in placesGeo only as a `country`. Excluding country
    // documents unconditionally made every city-state slug unresolvable.
    findArrayImpl = async () => [
      {
        _id: "sg-country",
        name: "Singapore",
        geoType: "country",
        geo: { type: "Point", coordinates: [103.82, 1.35] },
        isoCode: "SG",
      },
    ];
    const loc = await resolveLocationSlug("singapore-sg");
    expect(loc?.name).toBe("Singapore");
    expect(loc?.country).toBe("SG");
  });

  it("does NOT let a country document hijack a slug whose name differs from it", async () => {
    // `/harare` must never resolve to the Zimbabwe country entry.
    findArrayImpl = async () => [
      {
        _id: "zw-country",
        name: "Harare",
        geoType: "country",
        geo: { type: "Point", coordinates: [0, 0] },
      },
    ];
    const loc = await resolveLocationSlug("harare");
    // Falls back to the seed's real coordinates, not the country document.
    expect(loc?._id).toBe("seed:harare");
    expect(loc?.lat).toBeCloseTo(-17.83, 1);
  });
});

describe("CITY_STATE_COUNTRIES", () => {
  it("mirrors the _CITY_STATES set in api/py/_locations.py", async () => {
    const { CITY_STATE_COUNTRIES } = await import("./places");
    expect([...CITY_STATE_COUNTRIES].sort()).toEqual(
      [
        "SG",
        "MC",
        "VA",
        "GI",
        "SM",
        "AD",
        "LI",
        "MT",
        "BN",
        "DJ",
        "BH",
        "QA",
        "KW",
      ].sort(),
    );
  });
});

describe("resolveSmartSlug — coordinate-first, no place record required", () => {
  beforeEach(() => {
    findOneImpl = async () => null;
    findArrayImpl = async () => [];
  });

  it("renders a coordinate that exists in NO database at all", async () => {
    // The whole point of the redesign: an empty placesGeo must not stop a page.
    const loc = await resolveLocationSlug("mbare-musika--ksy4d6r");
    expect(loc).not.toBeNull();
    expect(loc?.name).toBe("Mbare Musika");
    expect(loc?.lat).toBeCloseTo(-17.8, 0);
    expect(loc?.lon).toBeCloseTo(31.0, 0);
  });

  it("renders when the database THROWS on every call", async () => {
    findOneImpl = async () => {
      throw new Error("cluster unreachable");
    };
    findArrayImpl = async () => {
      throw new Error("cluster unreachable");
    };
    const loc = await resolveLocationSlug("harare--ksy4dd7");
    expect(loc?.name).toBe("Harare");
    expect(loc?.lat).toBeCloseTo(-17.83, 1);
  });

  it("carries a geohash-derived _id, never a fake placesGeo id", async () => {
    const loc = await resolveLocationSlug("harare--ksy4dd7");
    expect(loc?._id).toBe("geo:ksy4dd7");
  });

  it("works for a coordinate anywhere on Earth, mapped or not", async () => {
    // Middle of the Pacific — no city, no seed, no placesGeo. Still renders.
    const { buildSmartSlug } = await import("./smart-slug");
    const slug = buildSmartSlug("Point Nemo", -48.876, -123.393);
    const loc = await resolveLocationSlug(slug);
    expect(loc).not.toBeNull();
    expect(loc?.name).toBe("Point Nemo");
    expect(loc?.lat).toBeCloseTo(-48.876, 1);
  });

  it("prefers an exact placesGeo document stamped with the slug", async () => {
    findOneImpl = async () => ({
      _id: "platform-uuid",
      name: "Mbare Musika",
      slug: "mbare-musika-9f8e7d",
      geoType: "city",
      geo: { type: "Point", coordinates: [31.043, -17.849] },
      isoCode: "ZW",
      sourceProvenance: {
        mukokoSlug: "mbare-musika--ksy4d6r",
        mukokoProvince: "Harare",
        mukokoElevation: 1480,
        mukokoPoiType: "market",
      },
    });
    const loc = await resolveLocationSlug("mbare-musika--ksy4d6r");
    expect(loc?._id).toBe("platform-uuid");
    expect(loc?.province).toBe("Harare");
    expect(loc?.elevation).toBe(1480);
    expect(loc?.poiType).toBe("market");
  });

  it("takes regional context from a nearby placesGeo entry but keeps the slug's own name", async () => {
    // The URL is the more specific statement of what the visitor asked for;
    // placesGeo supplies the surroundings.
    findArrayImpl = async () => [];
    findOneImpl = async (filter: unknown) => {
      const f = filter as Record<string, unknown>;
      if (f["sourceProvenance.mukokoSlug"]) return null; // no exact match
      return {
        _id: "nearby-uuid",
        name: "Harare",
        geoType: "city",
        geo: { type: "Point", coordinates: [31.05, -17.83] },
        isoCode: "ZW",
        sourceProvenance: { mukokoProvince: "Harare Metropolitan" },
      };
    };
    const loc = await resolveLocationSlug("some-shop--ksy4dd7");
    expect(loc?.name).toBe("Some Shop");
    expect(loc?.province).toBe("Harare Metropolitan");
    expect(loc?.country).toBe("ZW");
  });

  it("falls back to the nearest shipped seed for country/province context", async () => {
    // Nothing in placesGeo, but the coordinate is near Harare, so the country
    // and province are a sound regional approximation.
    const loc = await resolveLocationSlug("unnamed-spot--ksy4dd7");
    expect(loc?.name).toBe("Unnamed Spot");
    expect(loc?.country).toBe("ZW");
    expect(loc?.province).toBeTruthy();
  });

  it("leaves legacy slugs to the catalog path untouched", async () => {
    // `gweru` is alphabet-valid as a geohash; it must NOT be read as one.
    const loc = await resolveLocationSlug("gweru");
    expect(loc?.name).toBe("Gweru");
    expect(loc?.lat).toBeCloseTo(-19.45, 1);
    expect(loc?._id).toBe("seed:gweru");
  });
});

describe("resolvePlaceSlug — identity from the map", () => {
  beforeEach(() => {
    findOneImpl = async () => null;
    findArrayImpl = async () => [];
  });

  it("resolves by the map ref, not by proximity", async () => {
    findOneImpl = async (filter: unknown) => {
      const f = filter as Record<string, unknown>;
      if (f["sourceProvenance.mukokoOsmRef"] !== "w890123") return null;
      return {
        _id: "platform-uuid",
        name: "Canberra Residences",
        geoType: "city",
        geo: { type: "Point", coordinates: [103.8203, 1.4491] },
        isoCode: "SG",
        sourceProvenance: {
          mukokoOsmRef: "w890123",
          mukokoProvince: "Sembawang",
        },
      };
    };
    const loc = await resolveLocationSlug("canberra-residences--osm-w890123");
    expect(loc?._id).toBe("platform-uuid");
    expect(loc?.name).toBe("Canberra Residences");
    expect(loc?.province).toBe("Sembawang");
  });

  it("does NOT return a neighbour's record for a different ref", async () => {
    // The join must be exact. Returning the nearest record here is what
    // collapsed Canberra Residences and Visionaire into one place.
    findOneImpl = async (filter: unknown) => {
      const f = filter as Record<string, unknown>;
      if (f["sourceProvenance.mukokoOsmRef"] === "w111222") {
        return {
          _id: "residences",
          name: "Canberra Residences",
          geo: { type: "Point", coordinates: [103.8203, 1.4491] },
          sourceProvenance: { mukokoOsmRef: "w111222" },
        };
      }
      return null;
    };
    // Visionaire is metres away but a different feature — must not resolve to
    // the Residences record.
    const loc = await resolveLocationSlug("visionaire--osm-w111223");
    expect(loc).toBeNull();
  });

  it("two neighbouring places resolve to two distinct records", async () => {
    const byRef: Record<string, Record<string, unknown>> = {
      w111222: {
        _id: "residences",
        name: "Canberra Residences",
        geo: { type: "Point", coordinates: [103.8203, 1.4491] },
        sourceProvenance: { mukokoOsmRef: "w111222" },
      },
      w111223: {
        _id: "visionaire",
        name: "Visionaire",
        geo: { type: "Point", coordinates: [103.8205, 1.4492] },
        sourceProvenance: { mukokoOsmRef: "w111223" },
      },
    };
    findOneImpl = async (filter: unknown) => {
      const ref = (filter as Record<string, string>)[
        "sourceProvenance.mukokoOsmRef"
      ];
      return byRef[ref] ?? null;
    };

    const a = await resolveLocationSlug("canberra-residences--osm-w111222");
    const b = await resolveLocationSlug("visionaire--osm-w111223");
    expect(a?._id).toBe("residences");
    expect(b?._id).toBe("visionaire");
    expect(a?._id).not.toBe(b?._id);
  });

  it("falls back to a record stamped with the slug itself", async () => {
    findOneImpl = async (filter: unknown) => {
      const f = filter as Record<string, unknown>;
      if (f["sourceProvenance.mukokoSlug"] !== "canberra-plaza--osm-w42")
        return null;
      return {
        _id: "legacy-stamped",
        name: "Canberra Plaza",
        geo: { type: "Point", coordinates: [103.82, 1.443] },
        sourceProvenance: { mukokoSlug: "canberra-plaza--osm-w42" },
      };
    };
    expect((await resolveLocationSlug("canberra-plaza--osm-w42"))?._id).toBe(
      "legacy-stamped",
    );
  });

  it("a spot slug still renders with no record at all", async () => {
    // Places need the map; spots do not. A paddock with nothing mapped on it
    // must still produce a working weather page.
    const loc = await resolveLocationSlug("west-paddock--ksy4dd7");
    expect(loc?.name).toBe("West Paddock");
    expect(loc?.lat).toBeCloseTo(-17.83, 1);
  });

  it("a spot near a known place borrows its context but not its identity", async () => {
    findOneImpl = async (filter: unknown) => {
      const f = filter as Record<string, unknown>;
      if (f["sourceProvenance.mukokoSlug"]) return null;
      return {
        _id: "nearby-city",
        name: "Harare",
        geoType: "city",
        geo: { type: "Point", coordinates: [31.05, -17.83] },
        isoCode: "ZW",
        sourceProvenance: { mukokoProvince: "Harare Metropolitan" },
      };
    };
    const loc = await resolveLocationSlug("west-paddock--ksy4dd7");
    expect(loc?.province).toBe("Harare Metropolitan");
    expect(loc?.name).toBe("West Paddock");
    // Crucially it did NOT adopt the city's identity.
    expect(loc?._id).toBe("geo:ksy4dd7");
  });
});
