import { describe, it, expect } from "vitest";
import { prepareHourlyData } from "./HourlyChart";
import { prepareDailyData } from "./DailyChart";
import { prepareAtmosphericData } from "./AtmosphericDetails";
import { hexWithAlpha } from "./charts/TimeSeriesChart";
import type { HourlyWeather, DailyWeather } from "@/lib/weather";

// ── hexWithAlpha color + opacity tests ────────────────────────────────────────

describe("hexWithAlpha", () => {
  it("applies alpha to 6-digit hex", () => {
    expect(hexWithAlpha("#0047AB", 0.5)).toBe("#0047AB80");
    expect(hexWithAlpha("#FFFFFF", 1)).toBe("#FFFFFFff");
    expect(hexWithAlpha("#000000", 0)).toBe("#00000000");
  });

  it("applies alpha to 3-digit hex (expands to 6-digit first)", () => {
    expect(hexWithAlpha("#FFF", 0.5)).toBe("#FFFFFF80");
    expect(hexWithAlpha("#000", 1)).toBe("#000000ff");
    expect(hexWithAlpha("#ABC", 0)).toBe("#AABBCC00");
  });

  it("applies alpha to 4-digit hex (RGBA shorthand, expands RGB)", () => {
    expect(hexWithAlpha("#FFF8", 0.5)).toBe("#FFFFFF80");
  });

  it("strips existing alpha from 8-digit hex", () => {
    expect(hexWithAlpha("#0047ABFF", 0.2)).toBe("#0047AB33");
  });

  it("converts rgb() to rgba()", () => {
    expect(hexWithAlpha("rgb(0, 71, 171)", 0.3)).toBe("rgba(0, 71, 171, 0.3)");
  });

  it("overrides rgba() alpha", () => {
    expect(hexWithAlpha("rgba(0, 71, 171, 1)", 0.5)).toBe("rgba(0, 71, 171, 0.5)");
  });

  it("returns transparent fallback for empty string", () => {
    expect(hexWithAlpha("", 0.5)).toBe("rgba(0, 0, 0, 0.5)");
  });

  it("returns transparent fallback for unresolved var()", () => {
    expect(hexWithAlpha("var(--chart-1)", 0.5)).toBe("rgba(0, 0, 0, 0.5)");
  });

  it("returns transparent fallback for invalid color strings", () => {
    expect(hexWithAlpha("not-a-color", 0.5)).toBe("rgba(0, 0, 0, 0.5)");
    expect(hexWithAlpha("#ZZZZZZ", 0.5)).toBe("rgba(0, 0, 0, 0.5)");
  });

  it("clamps alpha to 0-1 range", () => {
    expect(hexWithAlpha("#0047AB", -0.5)).toBe("#0047AB00");
    expect(hexWithAlpha("#0047AB", 2)).toBe("#0047ABff");
  });

  // ── HSL/HSLA ──────────────────────────────────────────────────────────────

  it("applies alpha to hsl() comma syntax", () => {
    expect(hexWithAlpha("hsl(210, 100%, 34%)", 0.5)).toBe("hsla(210, 100%, 34%, 0.5)");
  });

  it("overrides hsla() alpha", () => {
    expect(hexWithAlpha("hsla(210, 100%, 34%, 1)", 0.3)).toBe("hsla(210, 100%, 34%, 0.3)");
  });

  it("applies alpha to hsl() modern space syntax", () => {
    expect(hexWithAlpha("hsl(210 100% 34%)", 0.7)).toBe("hsla(210, 100%, 34%, 0.7)");
  });

  it("handles hsl with slash alpha syntax", () => {
    expect(hexWithAlpha("hsl(210 100% 34% / 0.8)", 0.4)).toBe("hsla(210, 100%, 34%, 0.4)");
  });

  // ── OKLCH ─────────────────────────────────────────────────────────────────

  it("applies alpha to oklch()", () => {
    expect(hexWithAlpha("oklch(0.51 0.159 264)", 0.5)).toBe("oklch(0.51 0.159 264 / 0.5)");
  });

  it("overrides oklch() existing alpha", () => {
    expect(hexWithAlpha("oklch(0.51 0.159 264 / 0.8)", 0.2)).toBe("oklch(0.51 0.159 264 / 0.2)");
  });

  // ── HWB ───────────────────────────────────────────────────────────────────

  it("applies alpha to hwb()", () => {
    expect(hexWithAlpha("hwb(210 10% 20%)", 0.6)).toBe("hwb(210 10% 20% / 0.6)");
  });

  it("overrides hwb() existing alpha", () => {
    expect(hexWithAlpha("hwb(210 10% 20% / 1)", 0.3)).toBe("hwb(210 10% 20% / 0.3)");
  });

  // ── RGB modern space syntax ───────────────────────────────────────────────

  it("applies alpha to rgb() modern space syntax", () => {
    expect(hexWithAlpha("rgb(0 71 171)", 0.4)).toBe("rgba(0, 71, 171, 0.4)");
  });

  it("handles rgb with slash alpha syntax", () => {
    expect(hexWithAlpha("rgb(0 71 171 / 0.8)", 0.5)).toBe("rgba(0, 71, 171, 0.5)");
  });

  // ── Named CSS colors ─────────────────────────────────────────────────────

  it("applies alpha to named CSS color", () => {
    expect(hexWithAlpha("coral", 0.5)).toBe("rgba(255, 127, 80, 0.5)");
    expect(hexWithAlpha("indigo", 0.3)).toBe("rgba(75, 0, 130, 0.3)");
  });

  it("handles named colors case-insensitively", () => {
    expect(hexWithAlpha("Red", 0.5)).toBe("rgba(255, 0, 0, 0.5)");
    expect(hexWithAlpha("BLUE", 0.7)).toBe("rgba(0, 0, 255, 0.7)");
  });

  it("returns transparent fallback for unknown named color", () => {
    expect(hexWithAlpha("notacolor", 0.5)).toBe("rgba(0, 0, 0, 0.5)");
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a mock HourlyWeather with 48 hours of data starting from a given base hour */
function mockHourly(baseDate: Date, hours = 48): HourlyWeather {
  const time: string[] = [];
  const temperature_2m: number[] = [];
  const apparent_temperature: number[] = [];
  const relative_humidity_2m: number[] = [];
  const precipitation_probability: number[] = [];
  const precipitation: number[] = [];
  const weather_code: number[] = [];
  const visibility: number[] = [];
  const cloud_cover: number[] = [];
  const surface_pressure: number[] = [];
  const wind_speed_10m: number[] = [];
  const wind_direction_10m: number[] = [];
  const wind_gusts_10m: number[] = [];
  const uv_index: number[] = [];
  const is_day: number[] = [];

  for (let i = 0; i < hours; i++) {
    const d = new Date(baseDate);
    d.setHours(baseDate.getHours() + i, 0, 0, 0);
    time.push(d.toISOString());
    const temp = 15 + Math.sin(i / 4) * 8;
    temperature_2m.push(temp); // oscillating temps
    apparent_temperature.push(temp - 2); // feels 2 degrees cooler
    relative_humidity_2m.push(60);
    precipitation_probability.push(i % 5 === 0 ? 30 : 0);
    precipitation.push(0);
    weather_code.push(0);
    visibility.push(10000);
    cloud_cover.push(40);
    surface_pressure.push(1013);
    wind_speed_10m.push(10);
    wind_direction_10m.push(180);
    wind_gusts_10m.push(18);
    uv_index.push(3);
    is_day.push(d.getHours() >= 6 && d.getHours() <= 18 ? 1 : 0);
  }

  return {
    time,
    temperature_2m,
    apparent_temperature,
    relative_humidity_2m,
    precipitation_probability,
    precipitation,
    weather_code,
    visibility,
    cloud_cover,
    surface_pressure,
    wind_speed_10m,
    wind_direction_10m,
    wind_gusts_10m,
    uv_index,
    is_day,
  };
}

function emptyHourly(): HourlyWeather {
  return {
    time: [],
    temperature_2m: [],
    apparent_temperature: [],
    relative_humidity_2m: [],
    precipitation_probability: [],
    precipitation: [],
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

function mockDaily(): DailyWeather {
  const days = 7;
  const baseDate = new Date("2026-02-10");
  const time: string[] = [];
  const weather_code: number[] = [];
  const temperature_2m_max: number[] = [];
  const temperature_2m_min: number[] = [];
  const apparent_temperature_max: number[] = [];
  const apparent_temperature_min: number[] = [];
  const sunrise: string[] = [];
  const sunset: string[] = [];
  const uv_index_max: number[] = [];
  const precipitation_sum: number[] = [];
  const precipitation_probability_max: number[] = [];
  const wind_speed_10m_max: number[] = [];
  const wind_gusts_10m_max: number[] = [];

  for (let i = 0; i < days; i++) {
    const d = new Date(baseDate);
    d.setDate(baseDate.getDate() + i);
    time.push(d.toISOString().split("T")[0]);
    weather_code.push(i === 0 ? 0 : 2);
    temperature_2m_max.push(28 + i);
    temperature_2m_min.push(14 - i);
    apparent_temperature_max.push(29 + i);
    apparent_temperature_min.push(13 - i);
    sunrise.push(`${d.toISOString().split("T")[0]}T05:30`);
    sunset.push(`${d.toISOString().split("T")[0]}T18:30`);
    uv_index_max.push(8);
    precipitation_sum.push(i * 2);
    precipitation_probability_max.push(i * 10);
    wind_speed_10m_max.push(15);
    wind_gusts_10m_max.push(25);
  }

  return {
    time,
    weather_code,
    temperature_2m_max,
    temperature_2m_min,
    apparent_temperature_max,
    apparent_temperature_min,
    sunrise,
    sunset,
    uv_index_max,
    precipitation_sum,
    precipitation_probability_max,
    wind_speed_10m_max,
    wind_gusts_10m_max,
  };
}

// ── prepareHourlyData ─────────────────────────────────────────────────────────

describe("prepareHourlyData", () => {
  it("returns exactly 24 data points", () => {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const hourly = mockHourly(now);
    const data = prepareHourlyData(hourly);
    expect(data).toHaveLength(24);
  });

  it("labels the first point as 'Now'", () => {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const hourly = mockHourly(now);
    const data = prepareHourlyData(hourly);
    expect(data[0].label).toBe("Now");
  });

  it("rounds temperature values", () => {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const hourly = mockHourly(now);
    const data = prepareHourlyData(hourly);
    for (const point of data) {
      expect(point.temp).toBe(Math.round(point.temp));
    }
  });

  it("rounds feels-like temperature values", () => {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const hourly = mockHourly(now);
    const data = prepareHourlyData(hourly);
    for (const point of data) {
      expect(point.feelsLike).toBe(Math.round(point.feelsLike));
    }
  });

  it("preserves rain probability values", () => {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const hourly = mockHourly(now);
    const data = prepareHourlyData(hourly);
    // Every 5th hour has 30% rain probability in our mock
    const rainyPoints = data.filter((p) => p.rain > 0);
    expect(rainyPoints.length).toBeGreaterThan(0);
    for (const point of rainyPoints) {
      expect(point.rain).toBe(30);
    }
  });

  it("returns empty array for insufficient data", () => {
    const data = prepareHourlyData(emptyHourly());
    expect(data).toHaveLength(0);
  });

  it("each point has temp, feelsLike, rain, and label fields", () => {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const hourly = mockHourly(now);
    const data = prepareHourlyData(hourly);
    for (const point of data) {
      expect(point).toHaveProperty("temp");
      expect(point).toHaveProperty("feelsLike");
      expect(point).toHaveProperty("rain");
      expect(point).toHaveProperty("label");
      expect(typeof point.temp).toBe("number");
      expect(typeof point.feelsLike).toBe("number");
      expect(typeof point.rain).toBe("number");
      expect(typeof point.label).toBe("string");
    }
  });
});

// ── prepareDailyData ──────────────────────────────────────────────────────────

describe("prepareDailyData", () => {
  it("returns 7 data points for a 7-day forecast", () => {
    const daily = mockDaily();
    const data = prepareDailyData(daily);
    expect(data).toHaveLength(7);
  });

  it("labels the first day as 'Today'", () => {
    const daily = mockDaily();
    const data = prepareDailyData(daily);
    expect(data[0].day).toBe("Today");
  });

  it("uses short weekday names for non-today days", () => {
    const daily = mockDaily();
    const data = prepareDailyData(daily);
    for (let i = 1; i < data.length; i++) {
      // Short weekday names are 3 chars (Mon, Tue, etc.)
      expect(data[i].day).not.toBe("Today");
      expect(data[i].day.length).toBeLessThanOrEqual(4);
    }
  });

  it("rounds high and low temperatures", () => {
    const daily = mockDaily();
    const data = prepareDailyData(daily);
    for (const point of data) {
      expect(point.high).toBe(Math.round(point.high));
      expect(point.low).toBe(Math.round(point.low));
    }
  });

  it("rounds feels-like high and low temperatures", () => {
    const daily = mockDaily();
    const data = prepareDailyData(daily);
    for (const point of data) {
      expect(point.feelsHigh).toBe(Math.round(point.feelsHigh));
      expect(point.feelsLow).toBe(Math.round(point.feelsLow));
    }
  });

  it("high is always greater than low", () => {
    const daily = mockDaily();
    const data = prepareDailyData(daily);
    for (const point of data) {
      expect(point.high).toBeGreaterThan(point.low);
    }
  });

  it("range tuple matches [low, high]", () => {
    const daily = mockDaily();
    const data = prepareDailyData(daily);
    for (const point of data) {
      expect(point.range).toEqual([point.low, point.high]);
    }
  });

  it("preserves precipitation probability", () => {
    const daily = mockDaily();
    const data = prepareDailyData(daily);
    expect(data[0].rain).toBe(0); // first day has 0% in mock
    expect(data[1].rain).toBe(10); // second day has 10%
  });
});

// ── prepareAtmosphericData ────────────────────────────────────────────────────

describe("prepareAtmosphericData", () => {
  it("returns exactly 24 data points", () => {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const hourly = mockHourly(now);
    const data = prepareAtmosphericData(hourly);
    expect(data).toHaveLength(24);
  });

  it("labels the first point as 'Now'", () => {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const hourly = mockHourly(now);
    const data = prepareAtmosphericData(hourly);
    expect(data[0].label).toBe("Now");
  });

  it("returns empty array for insufficient data", () => {
    const data = prepareAtmosphericData(emptyHourly());
    expect(data).toHaveLength(0);
  });

  it("each point has all atmospheric fields", () => {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const hourly = mockHourly(now);
    const data = prepareAtmosphericData(hourly);
    for (const point of data) {
      expect(point).toHaveProperty("humidity");
      expect(point).toHaveProperty("cloudCover");
      expect(point).toHaveProperty("pressure");
      expect(point).toHaveProperty("windSpeed");
      expect(point).toHaveProperty("windGusts");
      expect(point).toHaveProperty("uvIndex");
      expect(typeof point.humidity).toBe("number");
      expect(typeof point.cloudCover).toBe("number");
      expect(typeof point.pressure).toBe("number");
      expect(typeof point.windSpeed).toBe("number");
      expect(typeof point.windGusts).toBe("number");
      expect(typeof point.uvIndex).toBe("number");
    }
  });

  it("rounds pressure and wind values", () => {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const hourly = mockHourly(now);
    const data = prepareAtmosphericData(hourly);
    for (const point of data) {
      expect(point.pressure).toBe(Math.round(point.pressure));
      expect(point.windSpeed).toBe(Math.round(point.windSpeed));
      expect(point.windGusts).toBe(Math.round(point.windGusts));
    }
  });
});
