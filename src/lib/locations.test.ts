import { describe, it, expect } from "vitest";
import {
  LOCATIONS,
  ZW_LOCATIONS,
} from "./locations";
import { GLOBAL_LOCATIONS } from "./locations-global";
import { ZIMBABWE_BOUNDS } from "./seed-regions";
import type { WeatherLocation, ZimbabweLocation } from "./locations";

describe("LOCATIONS database", () => {
  it("contains at least 90 locations", () => {
    expect(LOCATIONS.length).toBeGreaterThanOrEqual(90);
  });

  it("contains both Zimbabwe and non-Zimbabwe locations", () => {
    const zwCount = LOCATIONS.filter((l) => !l.country || l.country === "ZW").length;
    const nonZwCount = LOCATIONS.filter((l) => l.country && l.country !== "ZW").length;
    expect(zwCount).toBeGreaterThanOrEqual(90);
    expect(nonZwCount).toBeGreaterThan(0);
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

  it("all Zimbabwe coordinates are within Zimbabwe bounds (with padding)", () => {
    for (const loc of ZW_LOCATIONS) {
      expect(loc.lat).toBeGreaterThanOrEqual(ZIMBABWE_BOUNDS.south - 1);
      expect(loc.lat).toBeLessThanOrEqual(ZIMBABWE_BOUNDS.north + 1);
      expect(loc.lon).toBeGreaterThanOrEqual(ZIMBABWE_BOUNDS.west - 1);
      expect(loc.lon).toBeLessThanOrEqual(ZIMBABWE_BOUNDS.east + 1);
    }
  });

  it("all elevations are non-negative", () => {
    for (const loc of LOCATIONS) {
      expect(loc.elevation).toBeGreaterThanOrEqual(0);
    }
  });

  it("contains key cities", () => {
    const cities = ["harare", "bulawayo", "mutare", "gweru", "masvingo", "victoria-falls"];
    for (const slug of cities) {
      expect(LOCATIONS.find((l) => l.slug === slug)).toBeTruthy();
    }
  });
});

describe("GLOBAL_LOCATIONS data integrity", () => {
  it("every entry has a non-ZW country code", () => {
    for (const loc of GLOBAL_LOCATIONS) {
      expect(loc.country).toBeDefined();
      expect(loc.country).not.toBe("ZW");
    }
  });

  it("every slug is URL-safe and ends with the country code suffix", () => {
    for (const loc of GLOBAL_LOCATIONS) {
      expect(loc.slug).toMatch(/^[a-z0-9-]+$/);
      // Slug should end with -XX where XX is the lowercase country code
      expect(loc.slug).toMatch(new RegExp(`-${loc.country!.toLowerCase()}$`));
    }
  });

  it("every entry has a provinceSlug that ends with the lowercase country code", () => {
    for (const loc of GLOBAL_LOCATIONS) {
      if (loc.provinceSlug) {
        expect(loc.provinceSlug).toMatch(
          new RegExp(`-${loc.country!.toLowerCase()}$`),
        );
      }
    }
  });

  it("coordinates are within plausible global bounds", () => {
    for (const loc of GLOBAL_LOCATIONS) {
      expect(loc.lat).toBeGreaterThanOrEqual(-90);
      expect(loc.lat).toBeLessThanOrEqual(90);
      expect(loc.lon).toBeGreaterThanOrEqual(-180);
      expect(loc.lon).toBeLessThanOrEqual(180);
    }
  });

  it("all slugs in GLOBAL_LOCATIONS are unique", () => {
    const slugs = GLOBAL_LOCATIONS.map((l) => l.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("source is set to 'seed' for all entries", () => {
    for (const loc of GLOBAL_LOCATIONS) {
      expect(loc.source).toBe("seed");
    }
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
