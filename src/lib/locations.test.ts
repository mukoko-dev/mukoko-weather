import { describe, it, expect } from "vitest";
import {
  LOCATIONS,
  ZIMBABWE_BOUNDS,
  SUPPORTED_REGIONS,
  isInSupportedRegion,
  getLocationBySlug,
  getLocationsByTag,
  searchLocations,
  findNearestLocation,
} from "./locations";
import type { WeatherLocation, ZimbabweLocation } from "./locations";

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

  it("returns null for coordinates far outside all supported regions", () => {
    // London (outside Africa and ASEAN)
    expect(findNearestLocation(51.5, -0.12)).toBeNull();
    // São Paulo (outside all regions)
    expect(findNearestLocation(-23.55, -46.63)).toBeNull();
  });

  it("returns a location for coordinates just inside the border", () => {
    // Near Beitbridge (southern border)
    const nearest = findNearestLocation(-22.2, 30.0);
    expect(nearest).toBeDefined();
    expect(nearest!.slug).toBe("beitbridge");
  });

  it("returns nearest for coordinates in supported regions (even if far from Zimbabwe)", () => {
    // Coordinates within Africa-dev region but far south — nearest is still a ZW location
    // because only ZW locations are in the static LOCATIONS array
    const nearest = findNearestLocation(-25.0, 30.0);
    // This is within Africa-dev region but far from any seed location
    expect(nearest).toBeDefined();
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

  it("is the first entry in SUPPORTED_REGIONS", () => {
    expect(ZIMBABWE_BOUNDS).toBe(SUPPORTED_REGIONS[0]);
  });
});

describe("SUPPORTED_REGIONS", () => {
  it("contains at least 3 regions", () => {
    expect(SUPPORTED_REGIONS.length).toBeGreaterThanOrEqual(3);
  });

  it("every region has required fields", () => {
    for (const region of SUPPORTED_REGIONS) {
      expect(region.id).toBeTruthy();
      expect(region.name).toBeTruthy();
      expect(region.north).toBeGreaterThan(region.south);
      expect(region.east).toBeGreaterThan(region.west);
      expect(region.center.lat).toBeGreaterThanOrEqual(region.south);
      expect(region.center.lat).toBeLessThanOrEqual(region.north);
      expect(region.center.lon).toBeGreaterThanOrEqual(region.west);
      expect(region.center.lon).toBeLessThanOrEqual(region.east);
    }
  });

  it("has unique IDs", () => {
    const ids = SUPPORTED_REGIONS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes Zimbabwe, ASEAN, and Africa", () => {
    const ids = SUPPORTED_REGIONS.map((r) => r.id);
    expect(ids).toContain("zw");
    expect(ids).toContain("asean");
    expect(ids).toContain("africa-dev");
  });
});

describe("isInSupportedRegion", () => {
  it("returns true for Zimbabwe coordinates", () => {
    expect(isInSupportedRegion(-17.83, 31.05)).toBe(true); // Harare
    expect(isInSupportedRegion(-20.15, 28.58)).toBe(true); // Bulawayo
  });

  it("returns true for ASEAN coordinates", () => {
    expect(isInSupportedRegion(13.75, 100.5)).toBe(true); // Bangkok
    expect(isInSupportedRegion(1.35, 103.82)).toBe(true); // Singapore
    expect(isInSupportedRegion(14.6, 120.98)).toBe(true); // Manila
  });

  it("returns true for African developing country coordinates", () => {
    expect(isInSupportedRegion(-1.29, 36.82)).toBe(true); // Nairobi
    expect(isInSupportedRegion(6.52, 3.38)).toBe(true); // Lagos
    expect(isInSupportedRegion(-33.92, 18.42)).toBe(true); // Cape Town
  });

  it("returns false for unsupported regions", () => {
    expect(isInSupportedRegion(51.5, -0.12)).toBe(false); // London
    expect(isInSupportedRegion(40.71, -74.01)).toBe(false); // New York
    expect(isInSupportedRegion(-23.55, -46.63)).toBe(false); // São Paulo
  });
});

describe("WeatherLocation type compatibility", () => {
  it("ZimbabweLocation is assignable to WeatherLocation", () => {
    const loc: ZimbabweLocation = {
      slug: "test",
      name: "Test",
      province: "Test Province",
      lat: -17.83,
      lon: 31.05,
      elevation: 1490,
      tags: ["city"],
    };
    // ZimbabweLocation should be usable wherever WeatherLocation is expected
    const weatherLoc: WeatherLocation = loc;
    expect(weatherLoc.slug).toBe("test");
  });

  it("WeatherLocation supports optional country and source fields", () => {
    const loc: WeatherLocation = {
      slug: "manila",
      name: "Manila",
      province: "Metro Manila",
      lat: 14.6,
      lon: 120.98,
      elevation: 16,
      tags: ["city"],
      country: "PH",
      source: "community",
    };
    expect(loc.country).toBe("PH");
    expect(loc.source).toBe("community");
  });
});
