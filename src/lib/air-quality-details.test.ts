import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AQI_RANGES,
  aqiScalePct,
  formatConcentration,
  freshnessLabel,
  guidanceFor,
  pollutantRows,
  whoNote,
  type AirQualityReading,
} from "./air-quality-details";
import { AQI_ADVICE } from "./display";

const reading = (over: Partial<AirQualityReading> = {}): AirQualityReading => ({
  aqi: 84,
  level: "moderate",
  dominantPollutant: "pm2_5",
  pollutants: {
    pm2_5: 28.4,
    pm10: 40,
    o3: 61.2,
    no2: 9.5,
    so2: null,
    co: 210,
    nh3: null,
  },
  subIndexes: { pm2_5: 84, pm10: 37, o3: 40, no2: 9, co: 2 },
  whoGuidelines: {
    pm2_5: 15,
    pm10: 45,
    o3: 100,
    no2: 25,
    so2: 40,
    co: 4000,
    nh3: 0,
  },
  source: "Open-Meteo Air Quality (CAMS)",
  fetchedAt: "2026-10-31T08:00:00Z",
  ...over,
});

describe("guidanceFor", () => {
  it("names the band and gives the EPA guidance, with a not-medical-advice note", () => {
    const g = guidanceFor(reading());
    expect(g.bandLabel).toBe("Moderate");
    expect(g.text).toBe(AQI_ADVICE.moderate);
    expect(g.disclaimer).toContain("not medical advice");
  });

  it("derives the level from the index when the answer has none", () => {
    expect(guidanceFor(reading({ aqi: 120, level: undefined })).text).toBe(
      AQI_ADVICE.unhealthy_sensitive,
    );
    expect(guidanceFor(reading({ aqi: 350, level: "bogus" })).text).toBe(
      AQI_ADVICE.hazardous,
    );
  });
});

describe("concentrations and WHO notes", () => {
  it("formats a concentration and never turns a gap into zero", () => {
    expect(formatConcentration(12.34)).toBe("12.3 µg/m³");
    expect(formatConcentration(250)).toBe("250 µg/m³");
    expect(formatConcentration(0)).toBe("0.0 µg/m³");
    expect(formatConcentration(null)).toBeNull();
    expect(formatConcentration(undefined)).toBeNull();
  });

  it("compares with the guideline only when both exist", () => {
    expect(whoNote(30, 15)).toBe("2.0× the WHO guideline");
    expect(whoNote(10, 15)).toBe("Within the WHO guideline");
    expect(whoNote(10, 0)).toBeNull(); // ammonia has none
    expect(whoNote(null, 15)).toBeNull();
    expect(whoNote(10, undefined)).toBeNull();
  });
});

describe("pollutantRows", () => {
  it("lists all seven, the main pollutant first, then by sub-index", () => {
    const rows = pollutantRows(reading());
    expect(rows).toHaveLength(7);
    expect(rows[0].key).toBe("pm2_5");
    expect(rows[0].isMain).toBe(true);
    expect(rows.slice(1, 3).map((r) => r.key)).toEqual(["o3", "pm10"]);
  });

  it("keeps a pollutant with no reading as no data, last among the unscored", () => {
    const rows = pollutantRows(reading());
    const so2 = rows.find((r) => r.key === "so2");
    expect(so2?.valueText).toBeNull();
    expect(so2?.subIndex).toBeNull();
    expect(so2?.who).toBeNull();
  });

  it("states the WHO comparison from the reading", () => {
    const pm25 = pollutantRows(reading()).find((r) => r.key === "pm2_5");
    expect(pm25?.who).toBe("1.9× the WHO guideline");
    expect(pm25?.valueText).toBe("28.4 µg/m³");
    expect(pm25?.subIndex).toBe(84);
  });

  it("copes with an answer that has no pollutants at all", () => {
    const rows = pollutantRows(
      reading({
        pollutants: {},
        subIndexes: undefined,
        dominantPollutant: null,
      }),
    );
    expect(rows.every((r) => r.valueText === null)).toBe(true);
  });
});

describe("freshnessLabel", () => {
  const at = Date.parse("2026-10-31T08:30:00Z");
  it("says how old the reading is", () => {
    expect(freshnessLabel("2026-10-31T08:29:40Z", at)).toBe("Updated just now");
    expect(freshnessLabel("2026-10-31T08:00:00Z", at)).toBe(
      "Updated 30 min ago",
    );
    expect(freshnessLabel("2026-10-31T05:30:00Z", at)).toBe("Updated 3 h ago");
    expect(freshnessLabel("2026-10-29T05:30:00Z", at)).toBe(
      "Updated more than a day ago",
    );
  });
  it("says nothing without a usable time", () => {
    expect(freshnessLabel(undefined, at)).toBeNull();
    expect(freshnessLabel("not a time", at)).toBeNull();
  });
});

describe("the scale", () => {
  it("lists six bands with their ranges, not colour alone", () => {
    expect(AQI_RANGES.map((r) => r.range)).toEqual([
      "0–50",
      "51–100",
      "101–150",
      "151–200",
      "201–300",
      "301+",
    ]);
  });
  it("gives each band an equal sixth of the bar", () => {
    expect(aqiScalePct(0)).toBe(0);
    expect(aqiScalePct(50)).toBeCloseTo(100 / 6);
    expect(aqiScalePct(500)).toBe(100);
    expect(aqiScalePct(9999)).toBe(100);
  });
});

describe("the air-quality card opens its detail", () => {
  const root = resolve(__dirname, "../..");
  const summary = readFileSync(
    resolve(root, "src/components/weather/AtmosphericSummary.tsx"),
    "utf-8",
  );
  const detail = readFileSync(
    resolve(root, "src/components/weather/AirQualityDetail.tsx"),
    "utf-8",
  );

  it("makes the card a labelled button that opens the dialog", () => {
    expect(summary).toContain('detailLabel="Air quality details"');
    expect(summary).toContain("<AirQualityDetail");
  });

  it("uses the shared dialog, remembers the AQ map layer and has no inline colour", () => {
    expect(detail).toContain('from "@/components/ui/dialog"');
    expect(detail).toContain("writeStoredMapLayer");
    expect(detail).toContain("AIR_QUALITY_LAYER_ID");
    expect(detail).not.toMatch(/style=\{\{/);
    expect(detail).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("prints the scale bands and the source", () => {
    expect(detail).toContain("AQI_RANGES");
    expect(detail).toContain("Source:");
    expect(detail).toContain("No data");
  });
});
