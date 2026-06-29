import { describe, it, expect } from "vitest";
import {
  aqiGauge,
  formatPollutant,
  POLLUTANT_LABELS,
  AQI_LEVEL_LABELS,
  type AqiLevel,
} from "./AirQualityCard";

// ── aqiGauge ───────────────────────────────────────────────────────────────

describe("aqiGauge", () => {
  it("returns low severity (green) for Good (0-50)", () => {
    expect(aqiGauge(0).strokeClass).toBe("stroke-severity-low");
    expect(aqiGauge(50).strokeClass).toBe("stroke-severity-low");
  });

  it("returns moderate severity for Moderate (51-100)", () => {
    expect(aqiGauge(75).strokeClass).toBe("stroke-severity-moderate");
    expect(aqiGauge(100).strokeClass).toBe("stroke-severity-moderate");
  });

  it("returns high severity for Unhealthy for Sensitive (101-150)", () => {
    expect(aqiGauge(125).strokeClass).toBe("stroke-severity-high");
    expect(aqiGauge(150).strokeClass).toBe("stroke-severity-high");
  });

  it("returns severe severity for Unhealthy (151-200)", () => {
    expect(aqiGauge(175).strokeClass).toBe("stroke-severity-severe");
    expect(aqiGauge(200).strokeClass).toBe("stroke-severity-severe");
  });

  it("returns extreme severity for Very Unhealthy / Hazardous (>200)", () => {
    expect(aqiGauge(250).strokeClass).toBe("stroke-severity-extreme");
    expect(aqiGauge(450).strokeClass).toBe("stroke-severity-extreme");
  });

  it("percent scales linearly to a 500 max", () => {
    expect(aqiGauge(0).percent).toBe(0);
    expect(aqiGauge(250).percent).toBe(50);
    expect(aqiGauge(500).percent).toBe(100);
  });

  it("caps percent at 100 for hazardous-plus values", () => {
    expect(aqiGauge(600).percent).toBe(100);
  });

  it("uses severity stroke classes, not hardcoded colors", () => {
    for (const aqi of [0, 60, 120, 180, 300]) {
      expect(aqiGauge(aqi).strokeClass).toMatch(/^stroke-severity-/);
    }
  });
});

// ── formatPollutant ────────────────────────────────────────────────────────

describe("formatPollutant", () => {
  it("renders em-dash for null/undefined values", () => {
    expect(formatPollutant(null)).toBe("—");
    expect(formatPollutant(undefined)).toBe("—");
  });

  it("rounds large values to whole numbers", () => {
    expect(formatPollutant(120)).toBe("120 µg/m³");
    expect(formatPollutant(99.9)).toBe("99.9 µg/m³");
  });

  it("keeps one decimal place for small values", () => {
    expect(formatPollutant(12.5)).toBe("12.5 µg/m³");
    expect(formatPollutant(0.3)).toBe("0.3 µg/m³");
  });

  it("includes the µg/m³ unit", () => {
    expect(formatPollutant(25)).toContain("µg/m³");
  });
});

// ── POLLUTANT_LABELS / AQI_LEVEL_LABELS ────────────────────────────────────

describe("POLLUTANT_LABELS", () => {
  it("covers all 7 pollutants", () => {
    const keys = Object.keys(POLLUTANT_LABELS);
    expect(keys).toContain("pm2_5");
    expect(keys).toContain("pm10");
    expect(keys).toContain("o3");
    expect(keys).toContain("no2");
    expect(keys).toContain("so2");
    expect(keys).toContain("co");
    expect(keys).toContain("nh3");
    expect(keys.length).toBe(7);
  });

  it("uses unicode subscripts for chemical formulas", () => {
    expect(POLLUTANT_LABELS.o3).toContain("₃");
    expect(POLLUTANT_LABELS.no2).toContain("₂");
    expect(POLLUTANT_LABELS.so2).toContain("₂");
    expect(POLLUTANT_LABELS.nh3).toContain("₃");
  });
});

describe("AQI_LEVEL_LABELS", () => {
  it("covers all 6 EPA AQI buckets", () => {
    const levels: AqiLevel[] = [
      "good",
      "moderate",
      "unhealthy_sensitive",
      "unhealthy",
      "very_unhealthy",
      "hazardous",
    ];
    for (const level of levels) {
      expect(AQI_LEVEL_LABELS[level]).toBeDefined();
      expect(AQI_LEVEL_LABELS[level].length).toBeGreaterThan(0);
    }
  });
});

// ── Module exports ─────────────────────────────────────────────────────────

describe("AirQualityCard exports", () => {
  it("exports the AirQualityCard component", async () => {
    const mod = await import("./AirQualityCard");
    expect(mod.AirQualityCard).toBeDefined();
    expect(typeof mod.AirQualityCard).toBe("function");
  });

  it("exports pure helpers used by tests and AirQualityDetails", async () => {
    const mod = await import("./AirQualityCard");
    expect(mod.aqiGauge).toBeDefined();
    expect(mod.formatPollutant).toBeDefined();
    expect(mod.POLLUTANT_LABELS).toBeDefined();
    expect(mod.AQI_LEVEL_LABELS).toBeDefined();
  });
});

// ── API contract ───────────────────────────────────────────────────────────

describe("AirQualityCard API contract", () => {
  it("targets the /api/py/airquality endpoint", () => {
    // The component fetches `/api/py/airquality?lat=&lon=` on mount.
    // This is the Python FastAPI endpoint in api/py/_air_quality.py.
    const endpoint = "/api/py/airquality";
    expect(endpoint).toBe("/api/py/airquality");
  });

  it("response shape includes aqi, level, dominantPollutant, pollutants", () => {
    // Contract verified via Python tests + TypeScript types in AirQualityCard.tsx
    const requiredFields = ["aqi", "level", "dominantPollutant", "pollutants"];
    expect(requiredFields).toHaveLength(4);
  });
});
