import { describe, it, expect } from "vitest";
import {
  transformInsights,
  computeCategorySuitability,
  suitabilityColors,
  transformHistory,
  type InsightsRecord,
} from "./HistoryDashboard";
import type { WeatherHistoryDoc } from "@/lib/db";

// ---------------------------------------------------------------------------
// Helpers to build mock data
// ---------------------------------------------------------------------------

function makeCurrent(overrides: Partial<WeatherHistoryDoc["current"]> = {}): WeatherHistoryDoc["current"] {
  return {
    temperature_2m: 28,
    relative_humidity_2m: 60,
    apparent_temperature: 30,
    precipitation: 0,
    weather_code: 1,
    cloud_cover: 40,
    surface_pressure: 1013,
    wind_speed_10m: 12,
    wind_direction_10m: 180,
    wind_gusts_10m: 25,
    is_day: 1,
    uv_index: 6,
    ...overrides,
  } as WeatherHistoryDoc["current"];
}

function makeDoc(date: string, opts: {
  insights?: WeatherHistoryDoc["insights"];
  current?: Partial<WeatherHistoryDoc["current"]>;
} = {}): WeatherHistoryDoc {
  return {
    locationSlug: "harare",
    date,
    current: makeCurrent(opts.current),
    hourly: {} as WeatherHistoryDoc["hourly"],
    daily: {
      temperature_2m_max: [32],
      temperature_2m_min: [18],
      apparent_temperature_max: [34],
      apparent_temperature_min: [16],
      precipitation_sum: [2.5],
      precipitation_probability_max: [40],
      uv_index_max: [8],
      wind_gusts_10m_max: [30],
      sunrise: ["2026-01-15T05:30:00"],
      sunset: ["2026-01-15T18:30:00"],
    } as WeatherHistoryDoc["daily"],
    insights: opts.insights,
    recordedAt: new Date(),
  };
}

function makeInsights(overrides: Partial<NonNullable<WeatherHistoryDoc["insights"]>> = {}): NonNullable<WeatherHistoryDoc["insights"]> {
  return {
    dewPoint: 15,
    heatStressIndex: 22,
    thunderstormProbability: 10,
    visibility: 12,
    uvHealthConcern: 5,
    gdd10To30: 18,
    gdd08To30: 20,
    gdd03To25: 22,
    evapotranspiration: 3.5,
    moonPhase: 4,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// transformInsights
// ---------------------------------------------------------------------------

describe("transformInsights", () => {
  it("returns empty array for docs without insights", () => {
    const docs = [makeDoc("2026-01-01"), makeDoc("2026-01-02")];
    expect(transformInsights(docs)).toEqual([]);
  });

  it("transforms docs with insights into InsightsRecord[]", () => {
    const docs = [
      makeDoc("2026-01-02", { insights: makeInsights() }),
      makeDoc("2026-01-01", { insights: makeInsights({ dewPoint: 8 }) }),
    ];
    const result = transformInsights(docs);
    expect(result).toHaveLength(2);
    // Should be sorted by date ascending
    expect(result[0].date).toBe("2026-01-01");
    expect(result[1].date).toBe("2026-01-02");
  });

  it("maps insight fields correctly", () => {
    const insights = makeInsights({
      dewPoint: 12.5,
      heatStressIndex: 26,
      thunderstormProbability: 35,
      visibility: 8,
      uvHealthConcern: 7,
      gdd10To30: 15,
      gdd08To30: 17,
      gdd03To25: 20,
      evapotranspiration: 4.2,
      moonPhase: 2,
    });
    const docs = [makeDoc("2026-01-01", { insights })];
    const result = transformInsights(docs);
    expect(result[0]).toEqual({
      date: "2026-01-01",
      dewPoint: 12.5,
      heatStress: 26,
      thunderstorm: 35,
      visibility: 8,
      uvConcern: 7,
      gddMaize: 15,
      gddSorghum: 17,
      gddPotato: 20,
      evapotranspiration: 4.2,
      moonPhase: 2,
    });
  });

  it("handles partial insights (missing fields become null)", () => {
    const insights = { dewPoint: 10 } as NonNullable<WeatherHistoryDoc["insights"]>;
    const docs = [makeDoc("2026-01-01", { insights })];
    const result = transformInsights(docs);
    expect(result[0].dewPoint).toBe(10);
    expect(result[0].heatStress).toBeNull();
    expect(result[0].thunderstorm).toBeNull();
    expect(result[0].visibility).toBeNull();
    expect(result[0].gddMaize).toBeNull();
  });

  it("filters out docs without insights from mixed input", () => {
    const docs = [
      makeDoc("2026-01-01"),
      makeDoc("2026-01-02", { insights: makeInsights() }),
      makeDoc("2026-01-03"),
      makeDoc("2026-01-04", { insights: makeInsights() }),
    ];
    const result = transformInsights(docs);
    expect(result).toHaveLength(2);
    expect(result[0].date).toBe("2026-01-02");
    expect(result[1].date).toBe("2026-01-04");
  });
});

// ---------------------------------------------------------------------------
// transformHistory
// ---------------------------------------------------------------------------

describe("transformHistory", () => {
  it("transforms docs into sorted HistoryRecord[]", () => {
    const docs = [makeDoc("2026-01-02"), makeDoc("2026-01-01")];
    const result = transformHistory(docs);
    expect(result).toHaveLength(2);
    expect(result[0].date).toBe("2026-01-01");
    expect(result[1].date).toBe("2026-01-02");
  });

  it("extracts daily fields correctly", () => {
    const docs = [makeDoc("2026-01-01")];
    const result = transformHistory(docs);
    expect(result[0].tempHigh).toBe(32);
    expect(result[0].tempLow).toBe(18);
    expect(result[0].feelsLikeHigh).toBe(34);
    expect(result[0].feelsLikeLow).toBe(16);
    expect(result[0].precipitation).toBe(2.5);
    expect(result[0].rainProbability).toBe(40);
  });

  it("extracts current conditions", () => {
    const docs = [makeDoc("2026-01-01")];
    const result = transformHistory(docs);
    expect(result[0].humidity).toBe(60);
    expect(result[0].cloudCover).toBe(40);
    expect(result[0].pressure).toBe(1013);
    expect(result[0].windSpeed).toBe(12);
  });

  it("computes daylight hours from sunrise/sunset", () => {
    const docs = [makeDoc("2026-01-01")];
    const result = transformHistory(docs);
    // 05:30 to 18:30 = 13 hours
    expect(result[0].daylightHours).toBe(13);
  });

  it("handles missing daily data by falling back to current", () => {
    const doc = makeDoc("2026-01-01");
    doc.daily = {} as WeatherHistoryDoc["daily"];
    const result = transformHistory([doc]);
    expect(result[0].tempHigh).toBe(28); // current.temperature_2m
    expect(result[0].precipitation).toBe(0); // current.precipitation
  });
});

// ---------------------------------------------------------------------------
// suitabilityColors
// ---------------------------------------------------------------------------

describe("suitabilityColors", () => {
  it("returns green/low severity for excellent", () => {
    const result = suitabilityColors("excellent");
    expect(result.label).toBe("Excellent");
    expect(result.colorClass).toContain("severity-low");
    expect(result.bgClass).toContain("severity-low");
  });

  it("returns green/low severity for good", () => {
    const result = suitabilityColors("good");
    expect(result.label).toBe("Good");
    expect(result.colorClass).toContain("severity-low");
  });

  it("returns moderate severity for fair", () => {
    const result = suitabilityColors("fair");
    expect(result.label).toBe("Fair");
    expect(result.colorClass).toContain("severity-moderate");
    expect(result.bgClass).toContain("severity-moderate");
  });

  it("returns severe severity for poor", () => {
    const result = suitabilityColors("poor");
    expect(result.label).toBe("Poor");
    expect(result.colorClass).toContain("severity-severe");
    expect(result.bgClass).toContain("severity-severe");
  });
});

// ---------------------------------------------------------------------------
// computeCategorySuitability
// ---------------------------------------------------------------------------

describe("computeCategorySuitability", () => {
  it("returns empty array for empty insights", () => {
    expect(computeCategorySuitability([])).toEqual([]);
  });

  it("returns all 6 categories when full insights data is available", () => {
    const records: InsightsRecord[] = [
      {
        date: "2026-01-01",
        dewPoint: 15,
        heatStress: 20,
        thunderstorm: 10,
        visibility: 12,
        uvConcern: 4,
        gddMaize: 18,
        gddSorghum: 20,
        gddPotato: 22,
        evapotranspiration: 3.5,
        moonPhase: 4,
      },
    ];
    const result = computeCategorySuitability(records);
    const categories = result.map((r) => r.category);
    expect(categories).toContain("farming");
    expect(categories).toContain("mining");
    expect(categories).toContain("sports");
    expect(categories).toContain("travel");
    expect(categories).toContain("tourism");
    expect(categories).toContain("casual");
    expect(result).toHaveLength(6);
  });

  it("computes farming suitability — excellent when GDD is high", () => {
    const records: InsightsRecord[] = [
      { date: "2026-01-01", dewPoint: 15, heatStress: null, thunderstorm: null, visibility: null, uvConcern: null, gddMaize: 20, gddSorghum: null, gddPotato: null, evapotranspiration: null, moonPhase: null },
    ];
    const result = computeCategorySuitability(records);
    const farming = result.find((r) => r.category === "farming");
    expect(farming).toBeDefined();
    expect(farming!.level).toBe("excellent");
  });

  it("computes farming suitability — poor when dew point is low (frost risk)", () => {
    const records: InsightsRecord[] = [
      { date: "2026-01-01", dewPoint: 2, heatStress: null, thunderstorm: null, visibility: null, uvConcern: null, gddMaize: 5, gddSorghum: null, gddPotato: null, evapotranspiration: null, moonPhase: null },
    ];
    const result = computeCategorySuitability(records);
    const farming = result.find((r) => r.category === "farming");
    expect(farming).toBeDefined();
    expect(farming!.level).toBe("poor");
  });

  it("computes farming suitability — fair when dew point is high (disease risk)", () => {
    const records: InsightsRecord[] = [
      { date: "2026-01-01", dewPoint: 22, heatStress: null, thunderstorm: null, visibility: null, uvConcern: null, gddMaize: 10, gddSorghum: null, gddPotato: null, evapotranspiration: null, moonPhase: null },
    ];
    const result = computeCategorySuitability(records);
    const farming = result.find((r) => r.category === "farming");
    expect(farming!.level).toBe("fair");
  });

  it("computes mining suitability — poor when heat stress is severe", () => {
    const records: InsightsRecord[] = [
      { date: "2026-01-01", dewPoint: null, heatStress: 30, thunderstorm: 10, visibility: null, uvConcern: null, gddMaize: null, gddSorghum: null, gddPotato: null, evapotranspiration: null, moonPhase: null },
    ];
    const result = computeCategorySuitability(records);
    const mining = result.find((r) => r.category === "mining");
    expect(mining).toBeDefined();
    expect(mining!.level).toBe("poor");
  });

  it("computes mining suitability — poor when storm risk is high", () => {
    const records: InsightsRecord[] = [
      { date: "2026-01-01", dewPoint: null, heatStress: 15, thunderstorm: 50, visibility: null, uvConcern: null, gddMaize: null, gddSorghum: null, gddPotato: null, evapotranspiration: null, moonPhase: null },
    ];
    const result = computeCategorySuitability(records);
    const mining = result.find((r) => r.category === "mining");
    expect(mining!.level).toBe("poor");
  });

  it("computes sports suitability — excellent when conditions are moderate", () => {
    const records: InsightsRecord[] = [
      { date: "2026-01-01", dewPoint: null, heatStress: 18, thunderstorm: null, visibility: null, uvConcern: 4, gddMaize: null, gddSorghum: null, gddPotato: null, evapotranspiration: null, moonPhase: null },
    ];
    const result = computeCategorySuitability(records);
    const sports = result.find((r) => r.category === "sports");
    expect(sports).toBeDefined();
    expect(sports!.level).toBe("excellent");
  });

  it("computes sports suitability — poor when too hot", () => {
    const records: InsightsRecord[] = [
      { date: "2026-01-01", dewPoint: null, heatStress: 30, thunderstorm: null, visibility: null, uvConcern: 4, gddMaize: null, gddSorghum: null, gddPotato: null, evapotranspiration: null, moonPhase: null },
    ];
    const result = computeCategorySuitability(records);
    const sports = result.find((r) => r.category === "sports");
    expect(sports!.level).toBe("poor");
  });

  it("computes travel suitability — poor when visibility is very low", () => {
    const records: InsightsRecord[] = [
      { date: "2026-01-01", dewPoint: null, heatStress: null, thunderstorm: 5, visibility: 0.5, uvConcern: null, gddMaize: null, gddSorghum: null, gddPotato: null, evapotranspiration: null, moonPhase: null },
    ];
    const result = computeCategorySuitability(records);
    const travel = result.find((r) => r.category === "travel");
    expect(travel).toBeDefined();
    expect(travel!.level).toBe("poor");
  });

  it("computes casual suitability — poor when thunderstorm risk is high", () => {
    const records: InsightsRecord[] = [
      { date: "2026-01-01", dewPoint: null, heatStress: 18, thunderstorm: 50, visibility: null, uvConcern: null, gddMaize: null, gddSorghum: null, gddPotato: null, evapotranspiration: null, moonPhase: null },
    ];
    const result = computeCategorySuitability(records);
    const casual = result.find((r) => r.category === "casual");
    expect(casual).toBeDefined();
    expect(casual!.level).toBe("poor");
  });

  it("only produces categories that have relevant data", () => {
    // Only dew point provided — should produce farming + nothing else
    const records: InsightsRecord[] = [
      { date: "2026-01-01", dewPoint: 15, heatStress: null, thunderstorm: null, visibility: null, uvConcern: null, gddMaize: null, gddSorghum: null, gddPotato: null, evapotranspiration: null, moonPhase: null },
    ];
    const result = computeCategorySuitability(records);
    const categories = result.map((r) => r.category);
    expect(categories).toContain("farming");
    // Mining needs heatStress or thunderstorm — neither present
    expect(categories).not.toContain("mining");
    // Sports needs heatStress or uvConcern — neither present
    expect(categories).not.toContain("sports");
  });

  it("includes proper colorClass and bgClass in results", () => {
    const records: InsightsRecord[] = [
      { date: "2026-01-01", dewPoint: 15, heatStress: 20, thunderstorm: 10, visibility: 12, uvConcern: 4, gddMaize: 18, gddSorghum: 20, gddPotato: 22, evapotranspiration: 3.5, moonPhase: 4 },
    ];
    const result = computeCategorySuitability(records);
    for (const entry of result) {
      expect(entry.colorClass).toBeTruthy();
      expect(entry.bgClass).toBeTruthy();
      expect(entry.icon).toBeTruthy();
      expect(entry.levelLabel).toBeTruthy();
      expect(entry.detail).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// db.ts — recordWeatherHistory with insights
// ---------------------------------------------------------------------------

describe("WeatherHistoryDoc insights field", () => {
  it("WeatherHistoryDoc interface includes optional insights field", async () => {
    // Read the source to verify the interface definition
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/db.ts", "utf-8");
    expect(source).toContain("insights?: WeatherData[\"insights\"]");
  });

  it("recordWeatherHistory persists insights when available", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/db.ts", "utf-8");
    // Verify the insights field is being saved in recordWeatherHistory
    expect(source).toContain("if (data.insights) fields.insights = data.insights");
  });
});
