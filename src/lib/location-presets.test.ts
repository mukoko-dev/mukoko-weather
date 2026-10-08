import { describe, it, expect } from "vitest";
import {
  PRESET_ALWAYS_SLUGS,
  PRESET_NEAREST_COUNT,
  haversineKm,
  hiddenSuggestedSlugs,
  isPresetAnchor,
  suggestPresetSlugs,
  visiblePresetSlugs,
} from "./location-presets";
import { LOCATIONS } from "./locations";

const HARARE = { lat: -17.8292, lon: 31.0522 };
const NAIROBI = { lat: -1.2921, lon: 36.8219 };

describe("haversineKm", () => {
  it("measures Harare to Bulawayo at roughly 380 km", () => {
    const bulawayo = LOCATIONS.find((l) => l.slug === "bulawayo");
    expect(bulawayo).toBeDefined();
    const km = haversineKm(HARARE, { lat: bulawayo!.lat, lon: bulawayo!.lon });
    expect(km).toBeGreaterThan(340);
    expect(km).toBeLessThan(420);
  });

  it("is zero for the same point", () => {
    expect(haversineKm(HARARE, HARARE)).toBe(0);
  });
});

describe("isPresetAnchor", () => {
  it("accepts finite coordinates inside WGS 84 bounds", () => {
    expect(isPresetAnchor({ lat: -17.8, lon: 31 })).toBe(true);
    expect(isPresetAnchor({ lat: 90, lon: -180 })).toBe(true);
  });

  it("rejects missing, non-numeric, non-finite and out-of-range values", () => {
    expect(isPresetAnchor(null)).toBe(false);
    expect(isPresetAnchor("harare")).toBe(false);
    expect(isPresetAnchor({ lat: "-17" as unknown as number, lon: 31 })).toBe(false);
    expect(isPresetAnchor({ lat: Number.NaN, lon: 31 })).toBe(false);
    expect(isPresetAnchor({ lat: 91, lon: 0 })).toBe(false);
    expect(isPresetAnchor({ lat: 0, lon: 181 })).toBe(false);
  });
});

describe("suggestPresetSlugs", () => {
  it("suggests Harare and Bulawayo alone when there is no anchor", () => {
    expect(suggestPresetSlugs(null)).toEqual(["harare", "bulawayo"]);
    expect(suggestPresetSlugs(undefined)).toEqual(["harare", "bulawayo"]);
  });

  it("treats an invalid anchor as no anchor", () => {
    expect(suggestPresetSlugs({ lat: 999, lon: 0 })).toEqual([
      "harare",
      "bulawayo",
    ]);
  });

  it("adds the nearest seeded cities first, then Harare and Bulawayo", () => {
    const list = suggestPresetSlugs(NAIROBI);
    expect(list).toHaveLength(PRESET_NEAREST_COUNT + PRESET_ALWAYS_SLUGS.length);
    expect(list.slice(-2)).toEqual(["harare", "bulawayo"]);
    // The nearest of the nearest is Nairobi itself (distance 0).
    expect(list[0]).toBe("nairobi-ke");
  });

  it("orders the nearest cities by distance from the anchor", () => {
    const list = suggestPresetSlugs(HARARE);
    const nearest = list.slice(0, PRESET_NEAREST_COUNT);
    const distances = nearest.map((slug) => {
      const loc = LOCATIONS.find((l) => l.slug === slug)!;
      return haversineKm(HARARE, { lat: loc.lat, lon: loc.lon });
    });
    const sorted = [...distances].sort((a, b) => a - b);
    expect(distances).toEqual(sorted);
  });

  it("never repeats a slug and always returns real seed slugs", () => {
    for (const anchor of [HARARE, NAIROBI, { lat: 0, lon: 0 }]) {
      const list = suggestPresetSlugs(anchor);
      expect(new Set(list).size).toBe(list.length);
      for (const slug of list) {
        expect(LOCATIONS.some((l) => l.slug === slug)).toBe(true);
      }
    }
  });

  it("is deterministic for the same anchor", () => {
    expect(suggestPresetSlugs(NAIROBI)).toEqual(suggestPresetSlugs(NAIROBI));
  });
});

describe("visiblePresetSlugs", () => {
  const suggested = ["nairobi-ke", "harare", "kampala-ug", "bulawayo"];

  it("keeps the suggestion order when nothing is hidden, saved or current", () => {
    expect(
      visiblePresetSlugs({
        anchor: null,
        hidden: [],
        saved: [],
        current: null,
        suggested,
      }),
    ).toEqual(suggested);
  });

  it("hides a hidden suggestion without touching the others", () => {
    expect(
      visiblePresetSlugs({
        anchor: null,
        hidden: ["harare"],
        saved: [],
        current: null,
        suggested,
      }),
    ).toEqual(["nairobi-ke", "kampala-ug", "bulawayo"]);
  });

  it("does not repeat a saved place or the current location as a preset", () => {
    expect(
      visiblePresetSlugs({
        anchor: null,
        hidden: [],
        saved: ["kampala-ug"],
        current: "nairobi-ke",
        suggested,
      }),
    ).toEqual(["harare", "bulawayo"]);
  });

  it("drops anything that is not a location slug and removes duplicates", () => {
    expect(
      visiblePresetSlugs({
        anchor: null,
        hidden: [],
        saved: [],
        current: null,
        suggested: ["explore", "Harare", "harare", "harare", "bulawayo"],
      }),
    ).toEqual(["harare", "bulawayo"]);
  });

  it("uses the anchor's suggestions when no override is given", () => {
    const visible = visiblePresetSlugs({
      anchor: NAIROBI,
      hidden: [],
      saved: [],
      current: null,
    });
    expect(visible).toEqual(suggestPresetSlugs(NAIROBI));
  });
});

describe("hiddenSuggestedSlugs", () => {
  it("lists only the hidden places that are actually suggested for this anchor", () => {
    expect(
      hiddenSuggestedSlugs(null, ["harare", "not-a-suggestion"]),
    ).toEqual(["harare"]);
  });

  it("is empty when nothing is hidden", () => {
    expect(hiddenSuggestedSlugs(NAIROBI, [])).toEqual([]);
    expect(hiddenSuggestedSlugs(NAIROBI, null)).toEqual([]);
  });
});
