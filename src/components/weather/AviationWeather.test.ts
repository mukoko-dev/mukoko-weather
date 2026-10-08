import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  deriveCeilingFt,
  deriveCloudBaseFt,
  summarizeCloudCover,
  formatAge,
  formatReportLine,
  minutesSince,
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

describe("formatAge", () => {
  it("reports minutes under an hour", () => {
    expect(formatAge(0)).toBe("just now");
    expect(formatAge(35)).toBe("35 min ago");
  });

  it("reports whole hours from 60 minutes", () => {
    expect(formatAge(60)).toBe("1 h ago");
    expect(formatAge(179)).toBe("2 h ago");
  });

  it("says so when the age is unknown", () => {
    expect(formatAge(null)).toBe("time unknown");
  });
});

describe("formatReportLine", () => {
  it("renders station, name, rounded distance and age", () => {
    expect(
      formatReportLine({
        icao: "FVRG",
        name: "Harare (Robert Gabriel Mugabe Intl)",
        distanceKm: 12.4,
        ageMinutes: 35,
        metar: [],
        taf: null,
      }),
    ).toBe("FVRG Harare (Robert Gabriel Mugabe Intl) · 12 km · 35 min ago");
  });

  it("omits the distance when the station was picked without one", () => {
    expect(
      formatReportLine({
        icao: "FVKB",
        name: null,
        distanceKm: null,
        ageMinutes: 5,
        metar: [],
        taf: null,
      }),
    ).toBe("FVKB · 5 min ago");
  });
});

describe("minutesSince", () => {
  const now = Date.parse("2026-10-08T16:00:00Z");

  it("counts whole minutes between the observation and now", () => {
    expect(minutesSince("2026-10-08T15:25:00Z", now)).toBe(35);
  });

  it("never reports a negative age for clock skew", () => {
    expect(minutesSince("2026-10-08T16:05:00Z", now)).toBe(0);
  });

  it("returns null for missing or unparseable times", () => {
    expect(minutesSince(null, now)).toBeNull();
    expect(minutesSince("not a date", now)).toBeNull();
  });
});

describe("AviationWeather — nearest-report wiring", () => {
  const src = readFileSync(resolve(__dirname, "AviationWeather.tsx"), "utf-8");

  it("takes coordinates, not a pre-resolved station code", () => {
    expect(src).toContain("lat: number;");
    expect(src).toContain("lon: number;");
    expect(src).not.toContain("icao: string;\n  /**");
  });

  it("asks the server for the nearest airport that actually has a report", () => {
    expect(src).toContain("/api/py/aviation/nearest-metar?lat=");
  });

  it("still supports picking a specific station via /api/py/metar", () => {
    expect(src).toContain("/api/py/metar?icao=");
  });

  it("labels the chosen station as the nearest report", () => {
    expect(src).toContain('"Nearest report"');
  });

  it("shows the server's explanation when no airport reports, instead of a blank card", () => {
    expect(src).toContain("message");
    expect(src).toContain("!loading && !failed && !view && message");
  });

  it("disables picker chips for stations without a recent report", () => {
    expect(src).toContain("disabled={!s.reported}");
  });

  it("never calls Date.now() during render (only inside fetch callbacks)", () => {
    const renderStart = src.indexOf("export function AviationWeather");
    const renderBody = src.slice(renderStart);
    const callbackIdx = renderBody.indexOf("Date.now()");
    // The only Date.now() must sit inside the fetch .then callback in the effect.
    const effectIdx = renderBody.indexOf("useEffect(");
    expect(callbackIdx).toBeGreaterThan(effectIdx);
  });
});
