import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { generateSlug } from "./geocoding";

const source = readFileSync(resolve(__dirname, "geocoding.ts"), "utf-8");

describe("geocoding module structure", () => {
  it("exports reverseGeocode function", () => {
    expect(source).toContain("export async function reverseGeocode");
  });

  it("exports forwardGeocode function", () => {
    expect(source).toContain("export async function forwardGeocode");
  });

  it("exports getElevation function", () => {
    expect(source).toContain("export async function getElevation");
  });

  it("exports generateSlug function", () => {
    expect(source).toContain("export function generateSlug");
  });

  it("uses Nominatim for reverse geocoding", () => {
    expect(source).toContain("nominatim.openstreetmap.org/reverse");
  });

  it("uses Open-Meteo for forward geocoding", () => {
    expect(source).toContain("geocoding-api.open-meteo.com/v1/search");
  });

  it("includes a User-Agent header for Nominatim", () => {
    expect(source).toContain("User-Agent");
    expect(source).toContain("mukoko-weather");
  });

  it("handles timeouts for external API calls", () => {
    expect(source).toContain("AbortSignal.timeout");
  });
});

describe("generateSlug", () => {
  it("converts name to lowercase kebab-case", () => {
    expect(generateSlug("Ho Chi Minh City", "VN")).toBe("ho-chi-minh-city-vn");
  });

  it("strips diacritics", () => {
    expect(generateSlug("São Paulo", "BR")).toBe("sao-paulo-br");
  });

  it("removes non-alphanumeric characters", () => {
    expect(generateSlug("City (New)", "PH")).toBe("city-new-ph");
  });

  it("does not append country code for Zimbabwe", () => {
    expect(generateSlug("Harare", "ZW")).toBe("harare");
  });

  it("appends country code for non-Zimbabwe locations", () => {
    expect(generateSlug("Manila", "PH")).toBe("manila-ph");
    expect(generateSlug("Bangkok", "TH")).toBe("bangkok-th");
  });

  it("handles empty country gracefully", () => {
    expect(generateSlug("TestCity", "")).toBe("testcity");
  });

  it("collapses multiple hyphens", () => {
    expect(generateSlug("New   York", "US")).toBe("new-york-us");
  });
});
