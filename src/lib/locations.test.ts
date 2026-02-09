import { describe, it, expect } from "vitest";
import {
  LOCATIONS,
  ZIMBABWE_BOUNDS,
  getLocationBySlug,
  getLocationsByTag,
  searchLocations,
  findNearestLocation,
} from "./locations";

describe("LOCATIONS database", () => {
  it("contains at least 90 locations", () => {
    expect(LOCATIONS.length).toBeGreaterThanOrEqual(90);
  });

  it("every location has required fields", () => {
    for (const loc of LOCATIONS) {
      expect(loc.slug).toBeTruthy();
      expect(loc.name).toBeTruthy();
      expect(loc.province).toBeTruthy();
      expect(typeof loc.lat).toBe("number");
      expect(typeof loc.lon).toBe("number");
      expect(typeof loc.elevation).toBe("number");
      expect(Array.isArray(loc.tags)).toBe(true);
      expect(loc.tags.length).toBeGreaterThan(0);
    }
  });

  it("every slug is unique", () => {
    const slugs = LOCATIONS.map((l) => l.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });

  it("every slug is URL-safe (lowercase, hyphenated)", () => {
    for (const loc of LOCATIONS) {
      expect(loc.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("all coordinates are within Zimbabwe bounds (with padding)", () => {
    for (const loc of LOCATIONS) {
      expect(loc.lat).toBeGreaterThanOrEqual(ZIMBABWE_BOUNDS.south - 1);
      expect(loc.lat).toBeLessThanOrEqual(ZIMBABWE_BOUNDS.north + 1);
      expect(loc.lon).toBeGreaterThanOrEqual(ZIMBABWE_BOUNDS.west - 1);
      expect(loc.lon).toBeLessThanOrEqual(ZIMBABWE_BOUNDS.east + 1);
    }
  });

  it("all elevations are positive", () => {
    for (const loc of LOCATIONS) {
      expect(loc.elevation).toBeGreaterThan(0);
    }
  });

  it("contains key cities", () => {
    const cities = ["harare", "bulawayo", "mutare", "gweru", "masvingo", "victoria-falls"];
    for (const slug of cities) {
      expect(LOCATIONS.find((l) => l.slug === slug)).toBeTruthy();
    }
  });
});

describe("getLocationBySlug", () => {
  it("returns Harare for 'harare'", () => {
    const loc = getLocationBySlug("harare");
    expect(loc).toBeDefined();
    expect(loc!.name).toBe("Harare");
    expect(loc!.province).toBe("Harare");
  });

  it("returns Victoria Falls for 'victoria-falls'", () => {
    const loc = getLocationBySlug("victoria-falls");
    expect(loc).toBeDefined();
    expect(loc!.name).toBe("Victoria Falls");
  });

  it("returns undefined for unknown slugs", () => {
    expect(getLocationBySlug("nonexistent")).toBeUndefined();
    expect(getLocationBySlug("")).toBeUndefined();
    expect(getLocationBySlug("HARARE")).toBeUndefined(); // case-sensitive
  });
});

describe("getLocationsByTag", () => {
  it("returns cities for 'city' tag", () => {
    const cities = getLocationsByTag("city");
    expect(cities.length).toBeGreaterThan(10);
    for (const city of cities) {
      expect(city.tags).toContain("city");
    }
  });

  it("returns national parks for 'national-park' tag", () => {
    const parks = getLocationsByTag("national-park");
    expect(parks.length).toBeGreaterThan(0);
    for (const park of parks) {
      expect(park.tags).toContain("national-park");
    }
  });

  it("returns farming regions for 'farming' tag", () => {
    const farms = getLocationsByTag("farming");
    expect(farms.length).toBeGreaterThan(10);
  });

  it("returns mining areas for 'mining' tag", () => {
    const mines = getLocationsByTag("mining");
    expect(mines.length).toBeGreaterThan(5);
  });
});

describe("searchLocations", () => {
  it("finds Harare by name", () => {
    const results = searchLocations("Harare");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].slug).toBe("harare");
  });

  it("finds locations by prefix (case-insensitive)", () => {
    const results = searchLocations("bul");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].slug).toBe("bulawayo");
  });

  it("finds locations by province substring", () => {
    const results = searchLocations("Manicaland");
    expect(results.length).toBeGreaterThan(0);
    for (const loc of results) {
      expect(
        loc.name.toLowerCase().includes("manicaland") ||
        loc.province.toLowerCase().includes("manicaland")
      ).toBe(true);
    }
  });

  it("returns empty array for empty query", () => {
    expect(searchLocations("")).toEqual([]);
    expect(searchLocations("   ")).toEqual([]);
  });

  it("returns empty array for gibberish", () => {
    expect(searchLocations("xyzqwerty")).toEqual([]);
  });

  it("prefix matches come before substring matches", () => {
    const results = searchLocations("chi");
    // "Chinhoyi", "Chipinge", "Chiredzi" etc. should come before "Mashingo Junction"
    const firstNames = results.slice(0, 3).map((r) => r.name.toLowerCase());
    for (const name of firstNames) {
      expect(name.startsWith("chi")).toBe(true);
    }
  });
});

describe("findNearestLocation", () => {
  it("finds Harare for Harare coordinates", () => {
    const nearest = findNearestLocation(-17.83, 31.05);
    expect(nearest).toBeDefined();
    expect(nearest!.slug).toBe("harare");
  });

  it("finds Bulawayo for Bulawayo coordinates", () => {
    const nearest = findNearestLocation(-20.15, 28.58);
    expect(nearest).toBeDefined();
    expect(nearest!.slug).toBe("bulawayo");
  });

  it("returns null for coordinates far outside Zimbabwe", () => {
    // London
    expect(findNearestLocation(51.5, -0.12)).toBeNull();
    // Tokyo
    expect(findNearestLocation(35.68, 139.69)).toBeNull();
  });

  it("returns a location for coordinates just inside the border", () => {
    // Near Beitbridge (southern border)
    const nearest = findNearestLocation(-22.2, 30.0);
    expect(nearest).toBeDefined();
    expect(nearest!.slug).toBe("beitbridge");
  });

  it("returns null for coordinates beyond 1-degree padding", () => {
    // Way south of Zimbabwe
    expect(findNearestLocation(-25.0, 30.0)).toBeNull();
  });
});

describe("ZIMBABWE_BOUNDS", () => {
  it("has valid bounds", () => {
    expect(ZIMBABWE_BOUNDS.north).toBeGreaterThan(ZIMBABWE_BOUNDS.south);
    expect(ZIMBABWE_BOUNDS.east).toBeGreaterThan(ZIMBABWE_BOUNDS.west);
  });

  it("center is within bounds", () => {
    expect(ZIMBABWE_BOUNDS.center.lat).toBeGreaterThan(ZIMBABWE_BOUNDS.south);
    expect(ZIMBABWE_BOUNDS.center.lat).toBeLessThan(ZIMBABWE_BOUNDS.north);
    expect(ZIMBABWE_BOUNDS.center.lon).toBeGreaterThan(ZIMBABWE_BOUNDS.west);
    expect(ZIMBABWE_BOUNDS.center.lon).toBeLessThan(ZIMBABWE_BOUNDS.east);
  });
});
