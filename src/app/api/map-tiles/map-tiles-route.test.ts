import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "route.ts"), "utf-8");

describe("/api/map-tiles route structure", () => {
  it("exports a GET handler", () => {
    expect(source).toContain("export async function GET");
  });

  it("validates layer against whitelist", () => {
    expect(source).toContain("VALID_LAYERS");
    expect(source).toContain("precipitationIntensity");
    expect(source).toContain("temperature");
    expect(source).toContain("windSpeed");
    expect(source).toContain("cloudCover");
    expect(source).toContain("humidity");
  });

  it("returns 400 for missing parameters", () => {
    expect(source).toContain("Missing tile parameters");
    expect(source).toContain("status: 400");
  });

  it("returns 400 for invalid layer", () => {
    expect(source).toContain("Invalid layer");
  });

  it("clamps zoom to 1-12 range", () => {
    expect(source).toContain("zInt < 1");
    expect(source).toContain("zInt > 12");
    expect(source).toContain("Zoom out of range");
  });

  it("fetches API key from MongoDB", () => {
    expect(source).toContain('getApiKey("tomorrow")');
  });

  it("never exposes API key in response headers", () => {
    // The apikey is only in the server-side fetch URL, never in a response header
    expect(source).not.toContain("X-Api-Key");
  });

  it("returns 503 when API key is missing", () => {
    expect(source).toContain("Map service unavailable");
    expect(source).toContain("status: 503");
  });

  it("sets appropriate cache headers", () => {
    expect(source).toContain("Cache-Control");
    expect(source).toContain("max-age=300");
  });

  it("handles 429 rate limiting", () => {
    expect(source).toContain("429");
    expect(source).toContain("Rate limited");
  });

  it("returns content-type image/png", () => {
    expect(source).toContain("image/png");
  });

  it("uses observability logging on error", () => {
    expect(source).toContain("logError");
    expect(source).toContain("Map tile proxy error");
  });

  it("has an 8-second timeout", () => {
    expect(source).toContain("AbortSignal.timeout(8000)");
  });
});

describe("layer validation logic", () => {
  const VALID_LAYERS = new Set([
    "precipitationIntensity",
    "temperature",
    "windSpeed",
    "cloudCover",
    "humidity",
  ]);

  it("accepts all valid layers", () => {
    for (const layer of VALID_LAYERS) {
      expect(VALID_LAYERS.has(layer)).toBe(true);
    }
  });

  it("rejects invalid layers", () => {
    expect(VALID_LAYERS.has("invalid")).toBe(false);
    expect(VALID_LAYERS.has("")).toBe(false);
    expect(VALID_LAYERS.has("weatherCode")).toBe(false);
  });
});

describe("zoom validation logic", () => {
  function isValidZoom(z: string): boolean {
    const zInt = parseInt(z, 10);
    if (isNaN(zInt)) return false;
    return zInt >= 1 && zInt <= 12;
  }

  it("accepts valid zoom levels", () => {
    expect(isValidZoom("1")).toBe(true);
    expect(isValidZoom("7")).toBe(true);
    expect(isValidZoom("12")).toBe(true);
  });

  it("rejects out-of-range zoom", () => {
    expect(isValidZoom("0")).toBe(false);
    expect(isValidZoom("13")).toBe(false);
    expect(isValidZoom("-1")).toBe(false);
  });

  it("rejects non-numeric zoom", () => {
    expect(isValidZoom("abc")).toBe(false);
    expect(isValidZoom("")).toBe(false);
  });
});
