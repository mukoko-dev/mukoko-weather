/**
 * AtmosphericSummary — pure helpers (AQI scale, trend sentence, next-24h rain
 * series, normals date, today's high) plus source-level contract checks.
 * Vitest runs in Node, so the component itself is validated by reading its
 * source rather than rendering it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  aqiScalePct,
  aqiTrendSentence,
  next24hPrecipSeries,
  localIsoDate,
  todayHighFrom,
} from "./AtmosphericSummary";
import type { DailyWeather, HourlyWeather } from "@/lib/weather";

const source = readFileSync(
  resolve(__dirname, "AtmosphericSummary.tsx"),
  "utf-8",
);

// ── aqiScalePct ─────────────────────────────────────────────────────────────

describe("aqiScalePct", () => {
  it("maps the bottom and top of the scale to 0 and 100", () => {
    expect(aqiScalePct(0)).toBe(0);
    expect(aqiScalePct(500)).toBe(100);
  });

  it("clamps out-of-range values", () => {
    expect(aqiScalePct(-20)).toBe(0);
    expect(aqiScalePct(900)).toBe(100);
  });

  it("places each EPA band edge on a sixth of the bar", () => {
    expect(aqiScalePct(50)).toBeCloseTo(100 / 6, 5);
    expect(aqiScalePct(100)).toBeCloseTo(200 / 6, 5);
    expect(aqiScalePct(300)).toBeCloseTo(500 / 6, 5);
  });

  it("is monotonic non-decreasing", () => {
    let prev = -1;
    for (let aqi = 0; aqi <= 500; aqi += 7) {
      const pct = aqiScalePct(aqi);
      expect(pct).toBeGreaterThanOrEqual(prev);
      prev = pct;
    }
  });
});

// ── aqiTrendSentence ────────────────────────────────────────────────────────

describe("aqiTrendSentence", () => {
  it("describes worse, better and similar against yesterday", () => {
    expect(aqiTrendSentence("worse")).toMatch(/Worse than yesterday/);
    expect(aqiTrendSentence("better")).toMatch(/Better than yesterday/);
    expect(aqiTrendSentence("similar")).toMatch(/About the same as yesterday/);
  });

  it("returns null when the trend is unknown", () => {
    expect(aqiTrendSentence(null)).toBeNull();
    expect(aqiTrendSentence(undefined)).toBeNull();
  });
});

// ── next24hPrecipSeries ─────────────────────────────────────────────────────

function hourlyFrom(
  start: string,
  count: number,
  precip: (i: number) => number,
): HourlyWeather {
  const time: string[] = [];
  const precipitation: number[] = [];
  const base = new Date(`${start}:00:00`);
  for (let i = 0; i < count; i++) {
    const d = new Date(base.getTime() + i * 3600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    time.push(
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`,
    );
    precipitation.push(precip(i));
  }
  return {
    time,
    precipitation,
    temperature_2m: [],
    apparent_temperature: [],
    relative_humidity_2m: [],
    precipitation_probability: [],
    weather_code: [],
    visibility: [],
    cloud_cover: [],
    surface_pressure: [],
    wind_speed_10m: [],
    wind_direction_10m: [],
    wind_gusts_10m: [],
    uv_index: [],
    is_day: [],
  };
}

describe("next24hPrecipSeries", () => {
  it("starts at the current hour and returns 24 slots", () => {
    const now = new Date("2026-10-08T14:30:00");
    const hourly = hourlyFrom("2026-10-08T10", 48, (i) => i);
    const series = next24hPrecipSeries(hourly, now);
    expect(series).toHaveLength(24);
    // 10:00 is index 0, so 14:00 is index 4.
    expect(series[0]).toBe(4);
    expect(series[23]).toBe(27);
  });

  it("returns an empty series when the forecast has no matching hour", () => {
    const now = new Date("2026-10-08T14:30:00");
    const hourly = hourlyFrom("2026-01-01T00", 24, () => 1);
    expect(next24hPrecipSeries(hourly, now)).toEqual([]);
  });

  it("returns an empty series when hourly data is missing", () => {
    expect(next24hPrecipSeries(undefined, new Date())).toEqual([]);
  });

  it("replaces non-finite values with zero", () => {
    const now = new Date("2026-10-08T00:00:00");
    const hourly = hourlyFrom("2026-10-08T00", 24, (i) =>
      i === 2 ? NaN : 0.5,
    );
    expect(next24hPrecipSeries(hourly, now)[2]).toBe(0);
  });
});

// ── localIsoDate / todayHighFrom ────────────────────────────────────────────

describe("localIsoDate", () => {
  it("formats the local calendar date as YYYY-MM-DD", () => {
    expect(localIsoDate(new Date(2026, 9, 8, 23, 59))).toBe("2026-10-08");
    expect(localIsoDate(new Date(2026, 0, 3))).toBe("2026-01-03");
  });
});

describe("todayHighFrom", () => {
  const daily = (max: number[]): DailyWeather => ({
    time: [],
    weather_code: [],
    temperature_2m_max: max,
    temperature_2m_min: [],
    apparent_temperature_max: [],
    apparent_temperature_min: [],
    sunrise: [],
    sunset: [],
    uv_index_max: [],
    precipitation_sum: [],
    precipitation_probability_max: [],
    wind_speed_10m_max: [],
    wind_gusts_10m_max: [],
  });

  it("rounds today's forecast high", () => {
    expect(todayHighFrom(daily([28.6, 30]))).toBe(29);
  });

  it("returns null when there is no forecast high", () => {
    expect(todayHighFrom(daily([]))).toBeNull();
    expect(todayHighFrom(undefined)).toBeNull();
  });
});

// ── source contract ─────────────────────────────────────────────────────────

describe("AtmosphericSummary source contract", () => {
  it("has no hardcoded colours or inline styles", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/rgba?\(/);
    expect(source).not.toMatch(/style=\{\{/);
  });

  it("builds every card from the shared widgets, not gauges", () => {
    for (const widget of [
      "CompassDial",
      "GradientScale",
      "MiniBars",
      "MoonDisc",
      "PressureDial",
      "ScaleReadout",
      "SunArc",
      "InsightCard",
      "InsightGrid",
    ]) {
      expect(source).toContain(widget);
    }
    expect(source).not.toMatch(/MetricCard/);
  });

  it("uses the deterministic metric-insights sentences", () => {
    for (const fn of [
      "windInsight",
      "uvInsight",
      "feelsLikeInsight",
      "precipitationInsight",
      "visibilityInsight",
      "humidityInsight",
      "pressureInsight",
      "sunInsight",
      "temperatureAverageInsight",
    ]) {
      expect(source).toContain(fn);
    }
  });

  it("gives each mineral edge a literal Tailwind class", () => {
    expect(source).toContain('"bg-mineral-cobalt"');
    expect(source).toContain('"bg-mineral-terracotta"');
    expect(source).toContain("w-1");
  });

  it("loads normals and AQI from the API and labels the sections", () => {
    expect(source).toContain("/api/py/normals");
    expect(source).toContain("/api/py/airquality");
    expect(source).toContain('aria-labelledby="atmospheric-heading"');
    expect(source).toContain('aria-labelledby="air-quality-heading"');
  });

  it("wraps the AQI card in LazySection and ChartErrorBoundary", () => {
    const lazyPos = source.indexOf('label="air-quality"');
    const boundaryPos = source.indexOf('name="air quality"');
    expect(lazyPos).toBeGreaterThan(-1);
    expect(boundaryPos).toBeGreaterThan(lazyPos);
  });

  it("keeps the 24h trends link to the atmosphere sub-route", () => {
    expect(source).toContain("/atmosphere");
    expect(source).toContain("24h trends →");
  });

  it("renders the slot for the haze panel directly under the AQI card", () => {
    const aqPos = source.indexOf("hasCoords && (");
    const slotPos = source.indexOf("{afterAirQuality}");
    expect(aqPos).toBeGreaterThan(-1);
    expect(slotPos).toBeGreaterThan(aqPos);
  });
});
