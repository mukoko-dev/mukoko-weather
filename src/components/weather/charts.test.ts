import { describe, it, expect } from "vitest";
import { prepareHourlyData } from "./HourlyChart";
import { prepareDailyData } from "./DailyChart";
import { prepareAtmosphericData } from "./AtmosphericDetails";
import type { HourlyWeather, DailyWeather } from "@/lib/weather";

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
