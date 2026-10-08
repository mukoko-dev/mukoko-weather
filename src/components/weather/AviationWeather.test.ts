import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
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
    expect(
      deriveCeilingFt(layers(["SCT", 2000], ["BKN", 3500], ["OVC", 8000])),
    ).toBe(3500);
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
    expect(summarizeCloudCover(layers(["FEW", 2000], ["OVC", 5000]))).toBe(
      "Overcast",
    );
    expect(summarizeCloudCover(layers(["FEW", 2000], ["SCT", 4000]))).toBe(
      "Scattered",
    );
    expect(summarizeCloudCover(layers(["BKN", 3000]))).toBe("Broken");
  });

  it("maps sky-clear codes to a clear label", () => {
    expect(summarizeCloudCover(layers(["SKC", null]))).toBe("Sky clear");
  });

  it("falls back to the raw code for unknown covers", () => {
    expect(summarizeCloudCover(layers(["XYZ", 1000]))).toBe("XYZ");
  });
});

describe("AviationWeather — station chip row layout stability", () => {
  const src = readFileSync(resolve(__dirname, "AviationWeather.tsx"), "utf-8");
  const pickerStart = src.indexOf('aria-label="Nearby aviation stations"');
  const pickerOpen = src.lastIndexOf("<div", pickerStart);
  const pickerClass = src.slice(pickerOpen, pickerStart);

  it("reserves the touch-target height on the chip row so it cannot reflow the card", () => {
    expect(pickerClass).toContain("min-h-[var(--touch-target-min)]");
  });

  it("keeps the chip row on one line (no wrap) so the DB-backed list can't change its height", () => {
    expect(pickerClass).not.toContain("flex-wrap");
    expect(pickerClass).toContain("overflow-x-auto");
  });

  it("stops each chip from shrinking or wrapping inside the row", () => {
    expect(src).toContain("${base} ${cls} shrink-0");
  });

  it("the touch-target token it references is defined in globals.css", () => {
    const css = readFileSync(
      resolve(__dirname, "../../app/globals.css"),
      "utf-8",
    );
    expect(css).toMatch(/--touch-target-min:\s*48px/);
  });
});
