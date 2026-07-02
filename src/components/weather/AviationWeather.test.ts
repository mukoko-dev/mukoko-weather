import { describe, it, expect } from "vitest";
import {
  deriveCeilingFt,
  deriveCloudBaseFt,
  summarizeCloudCover,
} from "./AviationWeather";

interface CloudLayer {
  cover: string;
  base_ft: number | null;
}

const layers = (...pairs: [string, number | null][]): CloudLayer[] =>
  pairs.map(([cover, base_ft]) => ({ cover, base_ft }));

describe("deriveCeilingFt", () => {
  it("returns null for a clear sky (no layers)", () => {
    expect(deriveCeilingFt([])).toBeNull();
  });

  it("returns null when only FEW/SCT layers exist (no ceiling)", () => {
    expect(deriveCeilingFt(layers(["FEW", 2000], ["SCT", 4000]))).toBeNull();
  });

  it("returns the lowest BKN/OVC base as the ceiling", () => {
    expect(deriveCeilingFt(layers(["SCT", 2000], ["BKN", 3500], ["OVC", 8000]))).toBe(3500);
  });

  it("treats OVC as a ceiling", () => {
    expect(deriveCeilingFt(layers(["OVC", 900]))).toBe(900);
  });

  it("ignores BKN/OVC layers with an unknown base", () => {
    expect(deriveCeilingFt(layers(["BKN", null], ["OVC", 1200]))).toBe(1200);
  });
});

describe("deriveCloudBaseFt", () => {
  it("returns null for a clear sky", () => {
    expect(deriveCloudBaseFt([])).toBeNull();
  });

  it("returns the lowest base across all layers (including FEW/SCT)", () => {
    expect(deriveCloudBaseFt(layers(["FEW", 1800], ["BKN", 3500]))).toBe(1800);
  });

  it("skips layers with a null base", () => {
    expect(deriveCloudBaseFt(layers(["FEW", null], ["SCT", 4200]))).toBe(4200);
  });
});

describe("summarizeCloudCover", () => {
  it("reports Clear for no layers", () => {
    expect(summarizeCloudCover([])).toBe("Clear");
  });

  it("reports the densest layer's label", () => {
    expect(summarizeCloudCover(layers(["FEW", 2000], ["OVC", 5000]))).toBe("Overcast");
    expect(summarizeCloudCover(layers(["FEW", 2000], ["SCT", 4000]))).toBe("Scattered");
    expect(summarizeCloudCover(layers(["BKN", 3000]))).toBe("Broken");
  });

  it("maps sky-clear codes to a clear label", () => {
    expect(summarizeCloudCover(layers(["SKC", null]))).toBe("Sky clear");
  });

  it("falls back to the raw code for unknown covers", () => {
    expect(summarizeCloudCover(layers(["XYZ", 1000]))).toBe("XYZ");
  });
});
