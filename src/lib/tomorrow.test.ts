import { describe, it, expect } from "vitest";
import { tomorrowCodeToWmo, normalizeTomorrowResponse } from "./tomorrow";

describe("tomorrowCodeToWmo", () => {
  it("maps clear/sunny to WMO 0", () => {
    expect(tomorrowCodeToWmo(1000)).toBe(0);
  });

  it("maps partly cloudy to WMO 2", () => {
    expect(tomorrowCodeToWmo(1101)).toBe(2);
  });

  it("maps cloudy to WMO 3 (overcast)", () => {
    expect(tomorrowCodeToWmo(1001)).toBe(3);
  });

  it("maps fog to WMO 45", () => {
    expect(tomorrowCodeToWmo(2000)).toBe(45);
    expect(tomorrowCodeToWmo(2100)).toBe(45);
  });

  it("maps rain variants to correct WMO codes", () => {
    expect(tomorrowCodeToWmo(4000)).toBe(51); // drizzle
    expect(tomorrowCodeToWmo(4200)).toBe(61); // light rain
    expect(tomorrowCodeToWmo(4001)).toBe(63); // rain
    expect(tomorrowCodeToWmo(4201)).toBe(65); // heavy rain
  });

  it("maps snow variants", () => {
    expect(tomorrowCodeToWmo(5001)).toBe(71); // flurries
    expect(tomorrowCodeToWmo(5000)).toBe(73); // snow
    expect(tomorrowCodeToWmo(5101)).toBe(75); // heavy snow
  });

  it("maps freezing rain to WMO 66/67", () => {
    expect(tomorrowCodeToWmo(6000)).toBe(66);
    expect(tomorrowCodeToWmo(6200)).toBe(66);
    expect(tomorrowCodeToWmo(6001)).toBe(67);
    expect(tomorrowCodeToWmo(6201)).toBe(67);
  });

  it("maps thunderstorm to WMO 95", () => {
    expect(tomorrowCodeToWmo(8000)).toBe(95);
  });

  it("maps ice pellets to WMO 77", () => {
    expect(tomorrowCodeToWmo(7000)).toBe(77);
    expect(tomorrowCodeToWmo(7101)).toBe(77);
    expect(tomorrowCodeToWmo(7102)).toBe(77);
  });

  it("returns 0 for unknown codes", () => {
    expect(tomorrowCodeToWmo(9999)).toBe(0);
  });
});

describe("normalizeTomorrowResponse", () => {
  const mockResponse = {
    timelines: {
      hourly: [
        {
          time: "2025-01-15T10:00:00Z",
          values: {
            temperature: 25.5,
            humidity: 60,
            temperatureApparent: 26.0,
            precipitationProbability: 10,
            rainIntensity: 0,
            weatherCode: 1101,
            cloudCover: 45,
            windSpeed: 12,
            windDirection: 180,
            windGust: 18,
            uvIndex: 6,
            visibility: 16,
            pressureSurfaceLevel: 1013,
            dewPoint: 15,
          },
        },
        {
          time: "2025-01-15T11:00:00Z",
          values: {
            temperature: 26.0,
            humidity: 58,
            temperatureApparent: 27.0,
            precipitationProbability: 15,
            rainIntensity: 0.5,
            weatherCode: 4200,
            cloudCover: 60,
            windSpeed: 14,
            windDirection: 190,
            windGust: 20,
            uvIndex: 7,
            visibility: 14,
            pressureSurfaceLevel: 1012,
            dewPoint: 16,
          },
        },
      ],
      daily: [
        {
          time: "2025-01-15T00:00:00Z",
          values: {
            temperatureMax: 30,
            temperatureMin: 18,
            weatherCodeMax: 1101,
            sunriseTime: "2025-01-15T05:30:00Z",
            sunsetTime: "2025-01-15T18:45:00Z",
            uvIndexMax: 8,
            precipitationProbabilityMax: 20,
            windSpeedMax: 15,
            windGustMax: 22,
            rainAccumulation: 2.5,
            snowAccumulation: 0,
          },
        },
      ],
    },
    location: { lat: -17.83, lon: 31.05 },
  };

  it("normalizes current conditions from first hourly entry", () => {
    const result = normalizeTomorrowResponse(mockResponse);
    expect(result.current.temperature_2m).toBe(25.5);
    expect(result.current.relative_humidity_2m).toBe(60);
    expect(result.current.apparent_temperature).toBe(26.0);
    expect(result.current.wind_speed_10m).toBe(12);
    expect(result.current.wind_direction_10m).toBe(180);
    expect(result.current.cloud_cover).toBe(45);
    expect(result.current.uv_index).toBe(6);
    expect(result.current.surface_pressure).toBe(1013);
  });

  it("maps Tomorrow.io weather codes to WMO in current conditions", () => {
    const result = normalizeTomorrowResponse(mockResponse);
    expect(result.current.weather_code).toBe(2); // 1101 → WMO 2
  });

  it("computes is_day from sunrise/sunset", () => {
    const result = normalizeTomorrowResponse(mockResponse);
    // 10:00 UTC is between sunrise 05:30 and sunset 18:45
    expect(result.current.is_day).toBe(1);
  });

  it("builds parallel arrays for hourly data", () => {
    const result = normalizeTomorrowResponse(mockResponse);
    expect(result.hourly.time).toHaveLength(2);
    expect(result.hourly.temperature_2m).toEqual([25.5, 26.0]);
    expect(result.hourly.relative_humidity_2m).toEqual([60, 58]);
    expect(result.hourly.precipitation_probability).toEqual([10, 15]);
    expect(result.hourly.wind_speed_10m).toEqual([12, 14]);
    expect(result.hourly.weather_code).toEqual([2, 61]); // WMO mapped
  });

  it("converts visibility from km to meters", () => {
    const result = normalizeTomorrowResponse(mockResponse);
    expect(result.hourly.visibility).toEqual([16000, 14000]);
  });

  it("builds parallel arrays for daily data", () => {
    const result = normalizeTomorrowResponse(mockResponse);
    expect(result.daily.time).toHaveLength(1);
    expect(result.daily.temperature_2m_max).toEqual([30]);
    expect(result.daily.temperature_2m_min).toEqual([18]);
    expect(result.daily.sunrise).toEqual(["2025-01-15T05:30:00Z"]);
    expect(result.daily.sunset).toEqual(["2025-01-15T18:45:00Z"]);
    expect(result.daily.uv_index_max).toEqual([8]);
    expect(result.daily.precipitation_probability_max).toEqual([20]);
    expect(result.daily.wind_speed_10m_max).toEqual([15]);
    expect(result.daily.wind_gusts_10m_max).toEqual([22]);
  });

  it("sums rain + snow accumulation for precipitation_sum", () => {
    const result = normalizeTomorrowResponse(mockResponse);
    expect(result.daily.precipitation_sum).toEqual([2.5]);
  });

  it("falls back to temperature when apparent temp is missing", () => {
    const result = normalizeTomorrowResponse(mockResponse);
    // No temperatureApparentMax in our mock → falls back to temperatureMax
    expect(result.daily.apparent_temperature_max).toEqual([30]);
    expect(result.daily.apparent_temperature_min).toEqual([18]);
  });

  it("provides metric current_units", () => {
    const result = normalizeTomorrowResponse(mockResponse);
    expect(result.current_units.temperature_2m).toBe("°C");
    expect(result.current_units.wind_speed_10m).toBe("km/h");
  });

  it("throws on empty hourly data", () => {
    const empty = {
      timelines: { hourly: [], daily: [] },
      location: { lat: 0, lon: 0 },
    };
    expect(() => normalizeTomorrowResponse(empty)).toThrow("empty hourly data");
  });
});
