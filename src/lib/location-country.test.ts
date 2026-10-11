import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  countryDisplayName,
  placeLine,
  reconcileCountry,
} from "./location-country";
import { countryForTimezone, ZONE_COUNTRY } from "./timezone-country";
import type { WeatherLocation } from "./locations";

const spot = (over: Partial<WeatherLocation> = {}): WeatherLocation => ({
  slug: "london--gcpvj0d",
  name: "London",
  province: "",
  lat: 51.5,
  lon: -0.12,
  elevation: 0,
  tags: ["city"],
  ...over,
});

describe("countryForTimezone — any place on Earth", () => {
  it.each([
    ["Europe/London", "GB"],
    ["Europe/Paris", "FR"],
    ["Asia/Dubai", "AE"],
    ["America/New_York", "US"],
    ["America/Sao_Paulo", "BR"],
    ["Asia/Kolkata", "IN"],
    ["Asia/Calcutta", "IN"],
    ["Australia/Sydney", "AU"],
    ["Asia/Tokyo", "JP"],
    ["America/Toronto", "CA"],
    ["Atlantic/Reykjavik", "IS"],
    ["Pacific/Auckland", "NZ"],
    ["Africa/Harare", "ZW"],
    ["Africa/Nairobi", "KE"],
    ["Asia/Singapore", "SG"],
  ])("%s → %s", (zone, cc) => {
    expect(countryForTimezone(zone)).toBe(cc);
  });

  it("names no country over the open ocean or for UTC", () => {
    expect(countryForTimezone("Etc/GMT+9")).toBeUndefined();
    expect(countryForTimezone("UTC")).toBeUndefined();
    expect(countryForTimezone("GMT")).toBeUndefined();
    expect(countryForTimezone(undefined)).toBeUndefined();
    expect(countryForTimezone("")).toBeUndefined();
  });

  it("maps only to ISO 3166-1 alpha-2 codes", () => {
    for (const cc of Object.values(ZONE_COUNTRY)) {
      expect(cc).toMatch(/^[A-Z]{2}$/);
    }
    // Every inhabited continent is covered, not just Africa + ASEAN.
    expect(Object.keys(ZONE_COUNTRY).length).toBeGreaterThan(400);
  });
});

describe("countryDisplayName", () => {
  it("keeps curated African names exactly", () => {
    expect(countryDisplayName("ZW")).toBe("Zimbabwe");
    expect(countryDisplayName("ke")).toBe("Kenya");
  });

  it("names every other ISO country instead of echoing the code", () => {
    expect(countryDisplayName("GB")).toBe("United Kingdom");
    expect(countryDisplayName("JP")).toBe("Japan");
    expect(countryDisplayName("BR")).toBe("Brazil");
    expect(countryDisplayName("IS")).toBe("Iceland");
  });

  it("returns empty for unknown/blank and the code for junk", () => {
    expect(countryDisplayName("")).toBe("");
    expect(countryDisplayName(undefined)).toBe("");
    expect(countryDisplayName("ZZ")).toBe("");
  });
});

describe("reconcileCountry", () => {
  it("fills a missing country from the forecast's zone", () => {
    expect(reconcileCountry(spot(), "Europe/London").country).toBe("GB");
  });

  it("never overrules a country we actually know", () => {
    const harare = spot({ slug: "harare", country: "ZW", province: "Harare" });
    expect(reconcileCountry(harare, "Africa/Maputo")).toBe(harare);
  });

  it("lets the zone correct a seed borrowed across a border", () => {
    const malaga = spot({
      country: "MA",
      province: "Tanger-Tetouan-Al Hoceima",
      regionApproximate: true,
    });
    const out = reconcileCountry(malaga, "Europe/Madrid");
    expect(out.country).toBe("ES");
    expect(out.province).toBe("");
  });

  it("keeps an approximate region the zone agrees with", () => {
    const near = spot({
      country: "ZW",
      province: "Midlands",
      regionApproximate: true,
    });
    expect(reconcileCountry(near, "Africa/Harare")).toBe(near);
  });

  it("changes nothing over the open ocean", () => {
    const ocean = spot({ name: "Pacific" });
    expect(reconcileCountry(ocean, "Etc/GMT+9")).toBe(ocean);
  });
});

describe("placeLine", () => {
  it("drops empty parts and repeats", () => {
    expect(placeLine("Reykjavik", "", "Iceland")).toBe("Reykjavik, Iceland");
    expect(placeLine("Harare", "Harare", "Zimbabwe")).toBe("Harare, Zimbabwe");
    expect(placeLine("Pacific", "", "")).toBe("Pacific");
  });
});

describe("pages use the reconciled country", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, p), "utf8");

  it("location page reconciles after the weather fetch", () => {
    const src = read("../app/[location]/page.tsx");
    expect(src).toContain("reconcileCountry(storedLocation, weather.timezone)");
    expect(src).toContain("countryDisplayName(countryCode)");
  });

  it("home page and client swap reconcile too", () => {
    expect(read("../app/page.tsx")).toContain(
      "reconcileCountry(seededLocation, weather.timezone)",
    );
    expect(read("../app/CurrentLocationHome.tsx")).toContain(
      "reconcileCountry(found, weather.timezone)",
    );
  });
});
