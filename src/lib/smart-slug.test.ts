/**
 * Tests for src/lib/smart-slug.ts — `{name}--{geohash}` URLs.
 */
import { describe, it, expect } from "vitest";
import {
  SMART_SLUG_DELIMITER,
  buildPlaceSlug,
  buildSmartSlug,
  isLegacySlug,
  isSmartSlug,
  nameFromSlugSegment,
  parseSmartSlug,
  slugifyName,
} from "./smart-slug";
import { encodeGeohash, isGeohash } from "./geohash";
import { LOCATIONS } from "./locations";

describe("slugifyName", () => {
  it("lowercases and dashes", () => {
    expect(slugifyName("Victoria Falls")).toBe("victoria-falls");
  });

  it("strips diacritics", () => {
    expect(slugifyName("São Paulo")).toBe("sao-paulo");
    expect(slugifyName("Côte d'Ivoire")).toBe("cote-d-ivoire");
  });

  it("collapses runs of punctuation to a single dash", () => {
    // This collapsing is exactly why `--` can never occur in a generated name,
    // and therefore why it is safe as the geohash delimiter.
    expect(slugifyName("St. Mary's  School")).toBe("st-mary-s-school");
    expect(slugifyName("A -- B")).toBe("a-b");
  });

  it("never emits the delimiter", () => {
    for (const input of [
      "A -- B",
      "x---y",
      "a__b",
      "!!!",
      "Foo -- Bar -- Baz",
    ]) {
      expect(slugifyName(input)).not.toContain(SMART_SLUG_DELIMITER);
    }
  });

  it("trims leading and trailing dashes", () => {
    expect(slugifyName("  --Harare--  ")).toBe("harare");
  });

  it("handles empty and junk input", () => {
    expect(slugifyName("")).toBe("");
    expect(slugifyName("!!!")).toBe("");
  });
});

describe("nameFromSlugSegment", () => {
  it("title-cases dashed segments", () => {
    expect(nameFromSlugSegment("mbare-musika")).toBe("Mbare Musika");
    expect(nameFromSlugSegment("harare")).toBe("Harare");
  });

  it("returns empty for empty input", () => {
    expect(nameFromSlugSegment("")).toBe("");
  });
});

describe("buildSmartSlug", () => {
  it("joins a slugified name to a geohash", () => {
    const slug = buildSmartSlug("Harare", -17.8292, 31.0522);
    expect(slug).toBe(
      `harare${SMART_SLUG_DELIMITER}${encodeGeohash(-17.8292, 31.0522)}`,
    );
  });

  it("is deterministic for the same name and coordinate", () => {
    const a = buildSmartSlug("Mbare Musika", -17.8492, 31.0432);
    const b = buildSmartSlug("Mbare Musika", -17.8492, 31.0432);
    expect(a).toBe(b);
  });

  it("round-trips through parseSmartSlug", () => {
    const slug = buildSmartSlug("Singapore American School", 1.4382, 103.8);
    const parsed = parseSmartSlug(slug)!;
    expect(parsed.name).toBe("Singapore American School");
    expect(parsed.lat!).toBeCloseTo(1.4382, 2);
  });

  it("still yields a usable URL for an unnamed coordinate", () => {
    const slug = buildSmartSlug("", -17.8292, 31.0522);
    expect(slug.startsWith(`place${SMART_SLUG_DELIMITER}`)).toBe(true);
    expect(isSmartSlug(slug)).toBe(true);
  });

  it("returns empty string for an unusable coordinate", () => {
    expect(buildSmartSlug("Nowhere", Number.NaN, 0)).toBe("");
    expect(buildSmartSlug("Nowhere", 91, 0)).toBe("");
  });
});

describe("parseSmartSlug", () => {
  it("decodes the embedded coordinate", () => {
    const parsed = parseSmartSlug("harare--ksy4dd7")!;
    expect(parsed.nameSlug).toBe("harare");
    expect(parsed.name).toBe("Harare");
    expect(parsed.geohash).toBe("ksy4dd7");
    expect(parsed.lat).toBeCloseTo(-17.83, 1);
    expect(parsed.lon).toBeCloseTo(31.05, 1);
  });

  it("exposes the cell bounds and error radius", () => {
    const parsed = parseSmartSlug("harare--ksy4dd7")!;
    expect(parsed.bounds!.latMin).toBeLessThan(parsed.lat!);
    expect(parsed.bounds!.latMax).toBeGreaterThan(parsed.lat!);
    expect(parsed.errorKm!).toBeGreaterThan(0);
    expect(parsed.errorKm!).toBeLessThan(0.2);
  });

  it("splits on the LAST delimiter so a name may contain one", () => {
    const parsed = parseSmartSlug("foo--bar--ksy4dd7")!;
    expect(parsed.nameSlug).toBe("foo--bar");
    expect(parsed.geohash).toBe("ksy4dd7");
  });

  it("accepts multi-word names", () => {
    expect(parseSmartSlug("mbare-musika--ksy4dd7")!.name).toBe("Mbare Musika");
  });

  it("is case-insensitive on the geohash", () => {
    expect(parseSmartSlug("harare--KSY4DD7")!.geohash).toBe("ksy4dd7");
  });

  it("rejects a slug with no delimiter", () => {
    expect(parseSmartSlug("harare")).toBeNull();
    expect(parseSmartSlug("nairobi-ke")).toBeNull();
  });

  it("rejects a delimiter followed by a non-geohash", () => {
    expect(parseSmartSlug("harare--hello!")).toBeNull();
    expect(parseSmartSlug("harare--aaa")).toBeNull(); // 'a' is outside the alphabet
    expect(parseSmartSlug("harare--")).toBeNull();
  });

  it("rejects an implausibly long geohash", () => {
    expect(parseSmartSlug(`harare--${"b".repeat(13)}`)).toBeNull();
  });

  it("handles empty input", () => {
    expect(parseSmartSlug("")).toBeNull();
  });
});

describe("legacy slug safety — the reason the delimiter is `--`", () => {
  it("treats every shipped seed slug as legacy, never as a coordinate", () => {
    // Six shipped slugs (gweru, kwekwe, chegutu, guruve, gutu, ngundu) are
    // themselves valid geohash strings. Read as coordinates they land nowhere
    // near the real towns — `gweru` decodes to 82.95 N in the Arctic Ocean.
    // Requiring `--` is what makes that misread impossible.
    for (const loc of LOCATIONS) {
      expect(isSmartSlug(loc.slug)).toBe(false);
      expect(isLegacySlug(loc.slug)).toBe(true);
    }
  });

  it("documents that some seed slugs really are alphabet-valid geohashes", () => {
    // If this ever drops to zero the hazard is gone, but the guard above should
    // stay regardless — new seed entries could reintroduce it at any time.
    const alsoValidGeohashes = LOCATIONS.filter((l) => isGeohash(l.slug)).map(
      (l) => l.slug,
    );
    expect(alsoValidGeohashes).toContain("gweru");
    expect(alsoValidGeohashes.length).toBeGreaterThan(0);
  });

  it("would have mislocated /gweru without the delimiter rule", () => {
    // Proof the hazard is real, not theoretical.
    const gweru = LOCATIONS.find((l) => l.slug === "gweru")!;
    const asCoordinate = parseSmartSlug(`x--${gweru.slug}`)!;
    expect(Math.abs(asCoordinate.lat! - gweru.lat)).toBeGreaterThan(50);
  });
});

describe("isSmartSlug / isLegacySlug", () => {
  it("are exact complements", () => {
    for (const slug of [
      "harare",
      "harare--ksy4dd7",
      "nairobi-ke",
      "x--aaa",
      "",
    ]) {
      if (!slug) continue;
      expect(isSmartSlug(slug)).toBe(!isLegacySlug(slug));
    }
  });
});

describe("place slugs — identity from the map", () => {
  it("builds a place slug from a map ref", () => {
    expect(buildPlaceSlug("Canberra Residences", "w890123")).toBe(
      "canberra-residences--osm-w890123",
    );
  });

  it("gives two neighbouring buildings two distinct slugs", () => {
    // The requirement that broke the coordinate-cell model.
    const residences = buildPlaceSlug("Canberra Residences", "w111222");
    const visionaire = buildPlaceSlug("Visionaire", "w111223");
    expect(residences).not.toBe(visionaire);
  });

  it("is stable for the same feature regardless of GPS jitter", () => {
    // No coordinate goes into a place slug, so jitter cannot move it.
    expect(buildPlaceSlug("Canberra Plaza", "w42")).toBe(
      buildPlaceSlug("Canberra Plaza", "w42"),
    );
  });

  it("parses back to a place ref, carrying no coordinate", () => {
    const parsed = parseSmartSlug("canberra-residences--osm-w890123")!;
    expect(parsed.name).toBe("Canberra Residences");
    expect(parsed.ref.kind).toBe("place");
    // A place's coordinate lives on the map and in our cache, never in the URL.
    expect(parsed.lat).toBeUndefined();
    expect(parsed.geohash).toBeUndefined();
  });

  it("still parses spot slugs, which DO carry a coordinate", () => {
    const parsed = parseSmartSlug("west-paddock--ksy4dd7")!;
    expect(parsed.ref.kind).toBe("spot");
    expect(parsed.lat).toBeCloseTo(-17.83, 1);
  });

  it("returns empty for an unusable ref so callers fall back to a spot slug", () => {
    expect(buildPlaceSlug("Somewhere", "")).toBe("");
    expect(buildPlaceSlug("Somewhere", "x1")).toBe("");
  });

  it("keeps a place slug distinguishable from a spot slug", () => {
    expect(isSmartSlug("canberra-residences--osm-w890123")).toBe(true);
    expect(isSmartSlug("west-paddock--ksy4dd7")).toBe(true);
    // And neither is mistakable for a legacy catalog slug.
    expect(isLegacySlug("harare")).toBe(true);
  });
});
