import { describe, expect, it } from "vitest";
import type { GeoResult } from "./geolocation";
import {
  SEED_NEAR_KM,
  chooseResolved,
  isPlaceholderSpot,
  shouldCreate,
  usableIpGeo,
} from "./location-choice";
import type { WeatherLocation } from "./locations";

const loc = (slug: string, name = slug): WeatherLocation => ({
  slug,
  name,
  province: "",
  lat: 1,
  lon: 2,
  elevation: 0,
  tags: [],
});

const result = (over: Partial<GeoResult>): GeoResult => ({
  status: "success",
  location: loc("harare"),
  coords: { lat: 1, lon: 2 },
  distanceKm: 0,
  ...over,
});

describe("isPlaceholderSpot / usableIpGeo", () => {
  it("named:false and namingSkipped are both placeholders", () => {
    expect(isPlaceholderSpot({ ...loc("a--b"), named: false })).toBe(true);
    expect(isPlaceholderSpot({ ...loc("a--b"), namingSkipped: true })).toBe(
      true,
    );
    expect(isPlaceholderSpot(loc("harare"))).toBe(false);
    expect(isPlaceholderSpot(null)).toBe(false);
  });

  it("the IP path uses a real or named answer, never a placeholder", () => {
    expect(usableIpGeo(loc("harare"))).toBe(true);
    expect(usableIpGeo({ ...loc("phuket--w1"), named: true } as never)).toBe(
      true,
    );
    expect(usableIpGeo({ ...loc("x--y"), named: false })).toBe(false);
    expect(usableIpGeo({ ...loc("x--y"), namingSkipped: true })).toBe(false);
    expect(usableIpGeo(undefined)).toBe(false);
    expect(usableIpGeo({ ...loc(""), name: "" })).toBe(false);
  });
});

describe("shouldCreate", () => {
  it("a spot named on demand escalates to create-on-demand", () => {
    expect(shouldCreate(result({ synthesized: true }), 3)).toBe(true);
  });

  it("a stored place further than the threshold escalates", () => {
    expect(shouldCreate(result({ distanceKm: 4 }), 3)).toBe(true);
    expect(shouldCreate(result({ distanceKm: 3 }), 3)).toBe(false);
    expect(shouldCreate(result({ distanceKm: null }), 3)).toBe(false);
  });

  it("a placeholder spot never escalates: nothing better exists", () => {
    expect(shouldCreate(result({ synthesized: true, unnamed: true }), 3)).toBe(
      false,
    );
    expect(
      shouldCreate(result({ synthesized: true, namingSkipped: true }), 3),
    ).toBe(false);
  });
});

describe("chooseResolved", () => {
  const seed = result({ location: loc("harare"), distanceKm: 20 });
  const label = result({
    status: "success",
    location: loc("12-35n-45-68e--s5b7zk3", "12.35°N 45.68°E"),
    synthesized: true,
    namingSkipped: true,
  });

  it("a coordinate label never replaces a real place within 50 km", () => {
    expect(chooseResolved(seed, label).slug).toBe("harare");
    expect(
      chooseResolved(seed, { ...label, namingSkipped: false, unnamed: true })
        .slug,
    ).toBe("harare");
  });

  it("a real place further than 50 km does not beat the create answer", () => {
    const far = result({
      location: loc("harare"),
      distanceKm: SEED_NEAR_KM + 1,
    });
    expect(chooseResolved(far, label).slug).toBe(label.location!.slug);
  });

  it("a named create answer wins", () => {
    const created = result({
      status: "created",
      location: loc("mbare-musika--osm-w1", "Mbare Musika"),
      isNew: true,
    });
    expect(chooseResolved(seed, created).slug).toBe("mbare-musika--osm-w1");
  });

  it("a spot named on demand is replaced by the create answer", () => {
    const named = result({
      location: loc("phuket--w1"),
      synthesized: true,
      distanceKm: 0,
    });
    const created = result({
      status: "created",
      location: loc("phuket-thai--osm-n9"),
    });
    expect(chooseResolved(named, created).slug).toBe("phuket-thai--osm-n9");
  });

  it("keeps the find-only answer when the create call failed", () => {
    expect(chooseResolved(seed, null).slug).toBe("harare");
    expect(
      chooseResolved(seed, result({ status: "error", location: null })).slug,
    ).toBe("harare");
  });
});
