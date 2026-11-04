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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** Mutable stand-in for the placesGeo collection, swapped per test. */
let findOneImpl: (filter: unknown) => Promise<unknown>;
let findArrayImpl: () => Promise<unknown[]>;

vi.mock("./places-geo-collection", () => ({
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

const { resolveLocationSlug, canonicalSlugForPlace } = await import("./places");
const { canonicalSlug } = await import("./slug-migration");

/** The Worker knows no place unless a test says so; never the live network. */
let workerFetch: ReturnType<typeof vi.fn>;
function stubWorker(answer: (url: string) => Response | Promise<Response>) {
  workerFetch = vi.fn(async (input: string | URL) => answer(String(input)));
  vi.stubGlobal("fetch", workerFetch);
}
const notFound = () =>
  new Response(JSON.stringify({ error: "not_found" }), { status: 404 });

// Every test starts with a Worker that knows no place, so none of them can reach
// the live network: a slug the store does not hold is asked of the Worker with a
// 2 s timeout, and in strict mode a timeout is a failed lookup, not "unknown".
// A test that needs another answer calls `stubWorker` again.
beforeEach(() => {
  stubWorker(notFound);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveLocationSlug — seed fallback", () => {
  beforeEach(() => {
    findOneImpl = async () => null;
    findArrayImpl = async () => [];
    stubWorker(notFound);
  });

  it("renders a shipped slug when placesGeo has NO matching document", async () => {
    const loc = await resolveLocationSlug("singapore-sg");
    expect(loc).not.toBeNull();
    expect(loc?.name).toBe("Singapore");
    // The legacy slug resolves, and comes back as the canonical one.
    expect(loc?.slug).toBe(canonicalSlug("singapore-sg"));
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
  it("mirrors CITY_STATES in weather_core::locations", async () => {
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

  it("never runs the name-guess query for an OSM place slug we don't hold", async () => {
    // The name-guess path would alias `canberra-plaza--osm-w1` onto any
    // same-named record; an unheld ref must simply miss.
    findOneImpl = async () => null;
    let nameQueries = 0;
    findArrayImpl = async () => {
      nameQueries += 1;
      return [
        {
          _id: "some-other-plaza",
          name: "Canberra Plaza Osm W1",
          geoType: "city",
          geo: { type: "Point", coordinates: [0, 0] },
        },
      ];
    };
    expect(await resolveLocationSlug("canberra-plaza--osm-w1")).toBeNull();
    expect(nameQueries).toBe(0);
  });

  it("still finds a ref-less record stamped with the place slug", async () => {
    // Refs are adopted, not migrated: an older record may carry only the
    // stamped mukokoSlug.
    findOneImpl = async (filter: unknown) => {
      const f = filter as Record<string, unknown>;
      return f["sourceProvenance.mukokoSlug"] === "old-plaza--osm-w77"
        ? {
            _id: "old-plaza",
            name: "Old Plaza",
            geoType: "city",
            geo: { type: "Point", coordinates: [31, -17.8] },
            sourceProvenance: { mukokoSlug: "old-plaza--osm-w77" },
          }
        : null;
    };
    expect((await resolveLocationSlug("old-plaza--osm-w77"))?._id).toBe(
      "old-plaza",
    );
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

  it("a coordinate spot (open water, polar ice, empty desert) reads as its coordinates", async () => {
    // Nothing names the point, so the slug's name half is its coordinates
    // (minted by the Worker's coordinate_spot); never "40 00s 20 00w".
    const loc = await resolveLocationSlug("40-00s-20-00w--78cu2yh");
    expect(loc?.name).toBe("40.00\u00b0S 20.00\u00b0W");
    expect(loc?.lat).toBeCloseTo(-40.0, 1);
    expect(loc?.lon).toBeCloseTo(-20.0, 1);
    const bare = await resolveLocationSlug("place--78cu2yh");
    expect(bare?.name).toBe("40.00\u00b0S 20.00\u00b0W");
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

describe("resolveLocationSlug — platform slugs from search", () => {
  beforeEach(() => {
    findOneImpl = async () => null;
    findArrayImpl = async () => [];
  });

  it("resolves a placesGeo platform slug (name-<6hex>) by exact slug match", async () => {
    // Search hands out `bulawayo-e7b1f4`; it used to render "Location not found".
    findOneImpl = async (filter) => {
      const f = filter as Record<string, unknown>;
      if (f.slug === "bulawayo-e7b1f4") {
        return {
          _id: "pg-bulawayo",
          name: "Bulawayo",
          slug: "bulawayo-e7b1f4",
          geoType: "city",
          isoCode: "ZW",
          geo: { type: "Point", coordinates: [28.58, -20.15] },
        };
      }
      return null;
    };
    const loc = await resolveLocationSlug("bulawayo-e7b1f4");
    expect(loc?.name).toBe("Bulawayo");
    // A platform slug for a shipped city is that city's canonical slug, so
    // the proxy can 308 it and one city has one URL.
    expect(loc?.slug).toBe(canonicalSlug("bulawayo"));
    expect(loc?.platformSlug).toBe("bulawayo-e7b1f4");
    expect(loc?.lat).toBeCloseTo(-20.15, 1);
  });

  it("never resolves a platform slug to a country document", async () => {
    findOneImpl = async (filter) =>
      (filter as Record<string, unknown>).slug
        ? {
            _id: "c",
            name: "Narnia",
            slug: "narnia-abcdef",
            geoType: "country",
          }
        : null;
    expect(await resolveLocationSlug("narnia-abcdef")).toBeNull();
  });
});

describe("resolveLocationSlug — strict mode (#263)", () => {
  beforeEach(() => {
    findOneImpl = async () => null;
    findArrayImpl = async () => [];
  });

  it("rethrows a database error instead of answering not found", async () => {
    findOneImpl = async () => {
      throw new Error("mongo down");
    };
    await expect(
      resolveLocationSlug("zzzz-not-a-place", { strict: true }),
    ).rejects.toThrow("mongo down");
  });

  it("rethrows on an OSM place ref too", async () => {
    findOneImpl = async () => {
      throw new Error("mongo down");
    };
    await expect(
      resolveLocationSlug("canberra-residences--osm-w890123", { strict: true }),
    ).rejects.toThrow("mongo down");
  });

  it("still answers null for a genuinely unknown slug", async () => {
    await expect(
      resolveLocationSlug("zzzz-not-a-place", { strict: true }),
    ).resolves.toBeNull();
  });

  it("the default (render) mode still degrades instead of throwing", async () => {
    findOneImpl = async () => {
      throw new Error("mongo down");
    };
    await expect(resolveLocationSlug("zzzz-not-a-place")).resolves.toBeNull();
  });
});

// ── #414: a shipped place never 404s, and the Worker names community places ──

const SEMBAWANG_BODY = {
  location: {
    country: "SG",
    elevation: 8,
    lat: 1.444,
    lon: 103.824,
    name: "Sembawang",
    province: "Sembawang",
    provinceSlug: "sembawang-sg",
    slug: "sembawang-sg",
    source: "community",
    tags: ["city"],
  },
};

describe("resolveLocationSlug — a shipped place never 404s (#414)", () => {
  beforeEach(() => {
    findOneImpl = async () => null;
    findArrayImpl = async () => [];
    stubWorker(notFound);
  });

  it.each(["harare", "nairobi-ke", "lagos-ng", "singapore-sg"])(
    "%s renders when the stored geography throws",
    async (slug) => {
      findOneImpl = async () => {
        throw new Error("MongoServerSelectionError: connection timed out");
      };
      findArrayImpl = findOneImpl as () => Promise<unknown[]>;
      const loc = await resolveLocationSlug(slug);
      expect(loc?.slug).toBe(canonicalSlug(slug));
      expect(loc?._id).toBe(`seed:${slug}`);
    },
  );

  it("a shipped place renders when the stored geography HANGS (it is not waited for)", async () => {
    findOneImpl = () => new Promise(() => undefined);
    findArrayImpl = () => new Promise(() => undefined);
    const started = Date.now();
    const loc = await resolveLocationSlug("harare", { dbTimeoutMs: 30 });
    expect(loc?.slug).toBe(canonicalSlug("harare"));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("a shipped place never asks the Worker (it needs no lookup)", async () => {
    findOneImpl = async () => {
      throw new Error("down");
    };
    findArrayImpl = findOneImpl as () => Promise<unknown[]>;
    await resolveLocationSlug("harare");
    await resolveLocationSlug("nairobi-ke");
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it("an error OUTSIDE the lookups' own guards (the adapter on a matched name) does not turn a shipped place into a 404", async () => {
    // The name match at the end of the chain is adapted without a guard: a
    // malformed matched document used to throw out of the resolver, and the
    // loader turned any throw into "Location not found".
    const broken = {
      _id: "broken",
      name: "Harare",
      geoType: "city",
      get sourceProvenance(): never {
        throw new Error("malformed placesGeo document");
      },
    };
    findArrayImpl = async () => [broken];
    // Unguarded in the stored-geography step itself...
    await expect(
      resolveLocationSlug("harare", { strict: true }),
    ).rejects.toThrow("malformed placesGeo document");
    // ...and absorbed on the render path: the shipped place renders.
    const loc = await resolveLocationSlug("harare");
    expect(loc?.slug).toBe(canonicalSlug("harare"));
    expect(loc?._id).toBe("seed:harare");
  });
});

describe("resolveLocationSlug — a place the Worker names (#414)", () => {
  beforeEach(() => {
    findOneImpl = async () => null;
    findArrayImpl = async () => [];
  });

  it("renders sembawang-sg (not a seed) from the Worker when the stored geography misses", async () => {
    stubWorker((url) =>
      url.includes("slug=sembawang-sg")
        ? new Response(JSON.stringify(SEMBAWANG_BODY))
        : notFound(),
    );
    const loc = await resolveLocationSlug("sembawang-sg");
    expect(loc).toMatchObject({
      slug: "sembawang-sg",
      name: "Sembawang",
      country: "SG",
    });
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });

  it("renders it when the stored geography throws or hangs", async () => {
    stubWorker(() => new Response(JSON.stringify(SEMBAWANG_BODY)));
    findOneImpl = async () => {
      throw new Error("down");
    };
    findArrayImpl = findOneImpl as () => Promise<unknown[]>;
    expect((await resolveLocationSlug("sembawang-sg"))?.name).toBe("Sembawang");

    findOneImpl = () => new Promise(() => undefined);
    findArrayImpl = () => new Promise(() => undefined);
    expect(
      (await resolveLocationSlug("sembawang-sg", { dbTimeoutMs: 30 }))?.name,
    ).toBe("Sembawang");
  });

  it("is null when neither the store nor the Worker knows it (london-gb: the Worker answers 404)", async () => {
    stubWorker(notFound);
    expect(await resolveLocationSlug("london-gb")).toBeNull();
  });

  it("is null, not an error, when the Worker cannot answer on the render path", async () => {
    stubWorker(() => new Response("x", { status: 503 }));
    expect(await resolveLocationSlug("sembawang-sg")).toBeNull();
  });

  it("strict (the proxy gate) tells unknown from failed: a Worker 404 is unknown, a Worker outage throws", async () => {
    stubWorker(notFound);
    expect(await resolveLocationSlug("london-gb", { strict: true })).toBeNull();

    stubWorker(() => new Response("x", { status: 503 }));
    await expect(
      resolveLocationSlug("sembawang-sg", { strict: true }),
    ).rejects.toThrow();
  });

  it("strict: a stored-geography failure is rethrown unless the Worker found the place", async () => {
    findOneImpl = async () => {
      throw new Error("down");
    };
    findArrayImpl = findOneImpl as () => Promise<unknown[]>;
    stubWorker(notFound);
    await expect(
      resolveLocationSlug("london-gb", { strict: true }),
    ).rejects.toThrow("down");

    stubWorker(() => new Response(JSON.stringify(SEMBAWANG_BODY)));
    expect(
      (await resolveLocationSlug("sembawang-sg", { strict: true }))?.name,
    ).toBe("Sembawang");
  });

  it("a place only the store holds is not 404'd because the store was slow (the Worker said no, the store answers late)", async () => {
    stubWorker(notFound);
    findOneImpl = () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              _id: "late",
              name: "Latecomer",
              slug: "latecomer-a1b2c3",
              geoType: "city",
              geo: { type: "Point", coordinates: [31.05, -17.83] },
              isoCode: "ZW",
              sourceProvenance: { mukokoSlug: "latecomer-a1b2c3" },
            }),
          60,
        ),
      );
    const loc = await resolveLocationSlug("latecomer-a1b2c3", {
      dbTimeoutMs: 20,
    });
    expect(loc?._id).toBe("late");
  });

  it("a place the store holds costs no Worker call (the Worker is only the hedge)", async () => {
    stubWorker(notFound);
    findOneImpl = async () => ({
      _id: "held",
      name: "Heldtown",
      slug: "heldtown-a1b2c3",
      geoType: "city",
      geo: { type: "Point", coordinates: [31.05, -17.83] },
      isoCode: "ZW",
      sourceProvenance: { mukokoSlug: "heldtown-a1b2c3" },
    });
    const loc = await resolveLocationSlug("heldtown-a1b2c3");
    expect(loc?._id).toBe("held");
    expect(
      (await resolveLocationSlug("heldtown-a1b2c3", { strict: true }))?._id,
    ).toBe("held");
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it("the Worker is asked as soon as the store has missed, and after the hedge when the store is slow: the wait is the slower, not the sum", async () => {
    stubWorker(async () => {
      await new Promise((r) => setTimeout(r, 150));
      return new Response(JSON.stringify(SEMBAWANG_BODY));
    });
    findOneImpl = () =>
      new Promise((resolve) => setTimeout(() => resolve(null), 150));
    findArrayImpl = async () => [];
    const started = Date.now();
    const loc = await resolveLocationSlug("sembawang-sg", {
      strict: true,
      workerHedgeMs: 10,
    });
    const took = Date.now() - started;
    expect(loc?.name).toBe("Sembawang");
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(290); // asked one after the other it would be 300+
  });

  it("probes and junk never reach the Worker", async () => {
    stubWorker(notFound);
    for (const slug of ["wp-login", "admin", "ab", "x".repeat(81)]) {
      expect(await resolveLocationSlug(slug)).toBeNull();
    }
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it("a smart slug is never sent to the Worker (it carries its own coordinate)", async () => {
    stubWorker(notFound);
    await resolveLocationSlug("canberra-residences--osm-w890123");
    expect(workerFetch).not.toHaveBeenCalled();
  });
});

describe("resolveLocationSlug — canonical slugs (#317)", () => {
  beforeEach(() => {
    findOneImpl = async () => null;
    findArrayImpl = async () => [];
  });

  it("resolves a canonical seed slug as the seed itself, not as a bare spot", async () => {
    const loc = await resolveLocationSlug(canonicalSlug("bulawayo"));
    expect(loc?.slug).toBe(canonicalSlug("bulawayo"));
    expect(loc?._id).toBe("seed:bulawayo");
    // The seed's own province, tags and elevation, not a neighbour's.
    expect(loc?.province).toBe("Bulawayo");
    expect(loc?.tags).toContain("city");
    expect(loc?.elevationApproximate).toBeUndefined();
    expect(loc?.regionApproximate).toBeUndefined();
  });

  it("resolves the legacy and the canonical slug to the same place", async () => {
    const legacy = await resolveLocationSlug("nairobi-ke");
    const canonical = await resolveLocationSlug(canonicalSlug("nairobi-ke"));
    expect(legacy).toEqual({ ...canonical, updatedAt: legacy?.updatedAt });
    expect(legacy?.slug).toBe(canonicalSlug("nairobi-ke"));
  });

  it("leaves a spot and its own slug alone (a fixed point)", async () => {
    const loc = await resolveLocationSlug("west-paddock--ksy4dd7");
    expect(loc?.slug).toBe("west-paddock--ksy4dd7");
  });

  it("names the canonical slug of an old community slug from its coordinate", async () => {
    findOneImpl = async (filter) => {
      const f = filter as Record<string, unknown>;
      if (f["sourceProvenance.mukokoSlug"] === "mbare-musika-zw") {
        return {
          _id: "pg-mbare",
          name: "Mbare Musika",
          slug: "mbare-musika-9f8e7d",
          geoType: "town",
          isoCode: "ZW",
          geo: { type: "Point", coordinates: [31.0397, -17.8559] },
        };
      }
      return null;
    };
    const loc = await resolveLocationSlug("mbare-musika-zw");
    expect(loc?.slug).toMatch(/^mbare-musika--[0-9b-hjkmnp-z]{7}$/);
    expect(canonicalSlugForPlace({ ...loc! })).toBe(loc?.slug);
  });
});

describe("canonicalSlugForPlace (#317)", () => {
  it("maps a legacy seed slug through the pinned table", () => {
    expect(
      canonicalSlugForPlace({ slug: "harare", name: "Harare", lat: 0, lon: 0 }),
    ).toBe(canonicalSlug("harare"));
  });

  it("keeps a slug that is already {name}--{ref}", () => {
    expect(canonicalSlugForPlace({ slug: "x--ksy4dd7" })).toBe("x--ksy4dd7");
    expect(canonicalSlugForPlace({ slug: "x--osm-w1" })).toBe("x--osm-w1");
  });

  it("gives a seed's twin (same name within 25 km) the seed's slug", () => {
    expect(
      canonicalSlugForPlace({
        slug: "harare-35c223",
        name: "Harare",
        lat: -17.84,
        lon: 31.04,
      }),
    ).toBe(canonicalSlug("harare"));
  });

  it("does not adopt a same-named place far from the seed", () => {
    const slug = canonicalSlugForPlace({
      slug: "harare-aaaaaa",
      name: "Harare",
      lat: 51.5,
      lon: -0.12,
    });
    expect(slug).not.toBe(canonicalSlug("harare"));
    expect(slug.startsWith("harare--")).toBe(true);
  });

  it("never invents a URL without a coordinate or a name", () => {
    expect(canonicalSlugForPlace({ slug: "foo-ke" })).toBe("foo-ke");
    expect(
      canonicalSlugForPlace({ slug: "foo-ke", name: "Foo", lat: 0, lon: 0 }),
    ).toBe("foo-ke");
    expect(
      canonicalSlugForPlace({
        slug: "foo-ke",
        name: "Foo",
        lat: Number.NaN,
        lon: 3,
      }),
    ).toBe("foo-ke");
  });

  it("is idempotent", () => {
    const once = canonicalSlugForPlace({
      slug: "zed-123abc",
      name: "Zed",
      lat: 10,
      lon: 20,
    });
    expect(
      canonicalSlugForPlace({ slug: once, name: "Zed", lat: 10, lon: 20 }),
    ).toBe(once);
  });
});
