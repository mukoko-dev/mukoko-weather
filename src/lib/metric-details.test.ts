import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  METRIC_CHART,
  METRIC_KINDS,
  METRIC_TITLES,
  isMetricKind,
  metricDetail,
  metricSeries,
  moonriseLabel,
  uvForecastDays,
} from "./metric-details";
import type { WeatherData } from "./weather";

const N = 48;
const fill = <T>(v: T): T[] => Array.from({ length: N }, () => v);
const times = Array.from({ length: N }, (_, i) => {
  const day = 8 + Math.floor(i / 24);
  return `2026-10-${String(day).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00`;
});
const days = ["2026-10-08", "2026-10-09", "2026-10-10"];
const f7 = <T>(v: T): T[] => Array.from({ length: 3 }, () => v);

function weather(): WeatherData {
  return {
    current: {
      temperature_2m: 25,
      relative_humidity_2m: 60,
      apparent_temperature: 28,
      precipitation: 0,
      weather_code: 1,
      cloud_cover: 20,
      wind_speed_10m: 12,
      wind_direction_10m: 90,
      wind_gusts_10m: 20,
      uv_index: 6,
      surface_pressure: 1012,
      is_day: 1,
    },
    hourly: {
      time: times,
      temperature_2m: fill(25),
      apparent_temperature: fill(28),
      relative_humidity_2m: fill(60),
      precipitation_probability: fill(10),
      precipitation: fill(0.25),
      weather_code: fill(1),
      visibility: fill(12000),
      cloud_cover: fill(20),
      surface_pressure: fill(1012.4),
      wind_speed_10m: fill(12),
      wind_direction_10m: fill(90),
      wind_gusts_10m: fill(20),
      uv_index: fill(6),
      is_day: fill(1),
    },
    daily: {
      time: days,
      weather_code: f7(1),
      temperature_2m_max: f7(30),
      temperature_2m_min: f7(18),
      apparent_temperature_max: f7(32),
      apparent_temperature_min: f7(17),
      sunrise: days.map((d) => `${d}T05:20`),
      sunset: days.map((d) => `${d}T17:45`),
      uv_index_max: f7(10),
      precipitation_sum: f7(0),
      precipitation_probability_max: f7(0),
      wind_speed_10m_max: f7(15),
      wind_gusts_10m_max: f7(30),
    },
    current_units: {},
    utc_offset_seconds: 0,
  } as WeatherData;
}

// 14:00 local (offset 0), the same wall-clock hour as hourly index 14.
const NOW = new Date("2026-10-08T14:00:00Z");

describe("metric details", () => {
  it("knows every tile and titles each one", () => {
    expect(METRIC_KINDS).toHaveLength(10);
    for (const k of METRIC_KINDS) {
      expect(METRIC_TITLES[k]).toBeTruthy();
      expect(k in METRIC_CHART).toBe(true);
    }
    expect(isMetricKind("wind")).toBe(true);
    expect(isMetricKind("nope")).toBe(false);
    expect(isMetricKind(null)).toBe(false);
  });

  it("builds 24 hourly points from the location's current hour", () => {
    const series = metricSeries(weather().hourly, 0, NOW);
    expect(series).toHaveLength(24);
    expect(series[0].label).toBe("Now");
    expect(series[1].label).toBe("15:00");
  });

  it("converts visibility metres to km and rounds pressure", () => {
    const [p] = metricSeries(weather().hourly, 0, NOW);
    expect(p.visibility).toBe(12);
    expect(p.pressure).toBe(1012);
    expect(p.precipitation).toBe(0.3);
    expect(p.feelsLike).toBe(28);
  });

  it("derives a dew point when the model does not supply one", () => {
    const [p] = metricSeries(weather().hourly, 0, NOW);
    expect(p.dewPoint).toBeGreaterThan(10);
    expect(p.dewPoint).toBeLessThan(25);
  });

  it("returns no series for an empty forecast", () => {
    const w = weather();
    expect(metricSeries(undefined, 0, NOW)).toEqual([]);
    expect(metricSeries({ ...w.hourly, time: [] }, 0, NOW)).toEqual([]);
  });

  it("gives every metric a headline, sentence, about text and stats", () => {
    for (const k of METRIC_KINDS) {
      const d = metricDetail(k, weather(), NOW, {
        todayHigh: 31,
        normalHigh: 28,
        moonName: "Waning gibbous",
        moonIlluminationPct: 73,
      });
      expect(d.kind).toBe(k);
      expect(d.title).toBe(METRIC_TITLES[k]);
      expect(d.headline.length).toBeGreaterThan(0);
      expect(d.sentence.length).toBeGreaterThan(0);
      expect(d.about.length).toBeGreaterThan(20);
      expect(d.stats.length).toBeGreaterThan(0);
    }
  });

  it("states wind, uv and averages plainly", () => {
    expect(metricDetail("wind", weather(), NOW).headline).toBe("12 km/h E");
    expect(metricDetail("uv", weather(), NOW).headline).toContain("6");
    const avg = metricDetail("averages", weather(), NOW, {
      todayHigh: 31,
      normalHigh: 28,
    });
    expect(avg.sentence).toContain("3° above");
    expect(avg.stats[2].value).toBe("+3°");
  });

  it("never throws without a climate normal or moon data", () => {
    const avg = metricDetail("averages", weather(), NOW, { todayHigh: 31 });
    expect(avg.sentence).toContain("No climate average");
    expect(metricDetail("moon", weather(), NOW).headline).toBe("-");
  });
});

describe("tiles open the detail modal", () => {
  const root = resolve(__dirname, "../..");
  const summary = readFileSync(
    resolve(root, "src/components/weather/AtmosphericSummary.tsx"),
    "utf-8",
  );
  const modal = readFileSync(
    resolve(root, "src/components/weather/MetricDetailModal.tsx"),
    "utf-8",
  );

  const hitArea = readFileSync(
    resolve(root, "src/components/ui/card-hit-area.tsx"),
    "utf-8",
  );

  it("wires all ten tiles to setOpenMetric", () => {
    expect(summary.match(/onOpen=\{setOpenMetric\}/g)).toHaveLength(10);
    for (const k of METRIC_KINDS) {
      expect(summary).toContain(`metric="${k}"`);
    }
  });

  it("makes the tile a labelled button that opens a dialog", () => {
    // The overlay is the shared CardHitArea (aria-haspopup="dialog").
    expect(summary).toContain("<CardHitArea");
    expect(hitArea).toContain('aria-haspopup="dialog"');
    expect(summary).toContain("${METRIC_TITLES[metric]} details");
    expect(summary).toContain("aria-label={label}");
    expect(summary).not.toMatch(/absolute[^"']*\binset-y-0\b/);
  });

  it("isolates the chart and uses the shared Dialog and chart components", () => {
    expect(modal).toContain("ChartErrorBoundary");
    // The dialog scaffold is the one shared DetailSheet.
    expect(modal).toContain('from "@/components/ui/detail-sheet"');
    expect(modal).toContain("<DetailSheet");
    for (const c of [
      "WindSpeedChart",
      "UVIndexChart",
      "FeelsLikeChart",
      "VisibilityChart",
      "PrecipitationChart",
      "HumidityChart",
      "PressureChart",
    ]) {
      expect(modal).toContain(c);
    }
    expect(modal).not.toMatch(/style=\{\{/);
    expect(modal).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe("moonrise", () => {
  const HARARE = 2 * 3600; // UTC+2
  const now = Date.parse("2026-10-31T10:00:00Z"); // 12:00 in Harare

  it("reads the rise in the place's own clock, never the viewer's", () => {
    expect(moonriseLabel(Date.parse("2026-10-31T17:42:00Z"), now, HARARE)).toBe(
      "19:42",
    );
    // The same instant is 17:42 in London (UTC+0) and 01:42 next day in Singapore.
    expect(moonriseLabel(Date.parse("2026-10-31T17:42:00Z"), now, 0)).toBe(
      "17:42",
    );
    expect(
      moonriseLabel(Date.parse("2026-10-31T17:42:00Z"), now, 8 * 3600),
    ).toBe("01:42 tomorrow");
  });

  it("says tomorrow when the rise is on the next local day", () => {
    expect(moonriseLabel(Date.parse("2026-10-31T23:30:00Z"), now, HARARE)).toBe(
      "01:30 tomorrow",
    );
  });

  it("is null when the moon does not rise", () => {
    expect(moonriseLabel(null, now, HARARE)).toBeNull();
    expect(moonriseLabel(undefined, now, HARARE)).toBeNull();
    expect(moonriseLabel(Number.NaN, now, HARARE)).toBeNull();
  });

  it("appears in the moon sentence and stats when known", () => {
    const d = metricDetail("moon", weather(), NOW, {
      moonName: "Waning gibbous",
      moonIlluminationPct: 73,
      moonrise: "21:14",
    });
    expect(d.sentence).toBe("Waning gibbous, 73% lit. Moonrise 21:14.");
    expect(d.stats.find((x) => x.label === "Moonrise")?.value).toBe("21:14");
    const none = metricDetail("moon", weather(), NOW, {
      moonName: "Full moon",
      moonIlluminationPct: 100,
    });
    expect(none.sentence).toBe("Full moon, 100% lit.");
    expect(none.stats.find((x) => x.label === "Moonrise")?.value).toBe("-");
  });
});

describe("uvForecastDays", () => {
  it("labels today, then the weekday from the date itself", () => {
    const w = weather();
    const days = uvForecastDays(w.daily);
    expect(days).toHaveLength(3);
    expect(days[0]).toMatchObject({
      date: "2026-10-08",
      label: "Today",
      peak: 10,
      category: "Very High",
    });
    expect(days[1].label).toBe("Fri"); // 2026-10-09 is a Friday
    expect(days[2].label).toBe("Sat");
  });

  it("skips a day with no value instead of showing zero", () => {
    const w = weather();
    const daily = {
      ...w.daily,
      uv_index_max: [10, null, 3],
    } as unknown as typeof w.daily;
    const days = uvForecastDays(daily);
    expect(days.map((d) => d.label)).toEqual(["Today", "Sat"]);
    expect(days[1].category).toBe("Moderate");
    expect(uvForecastDays(undefined)).toEqual([]);
  });
});
