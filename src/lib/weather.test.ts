import { describe, it, expect } from "vitest";
import {
  checkFrostRisk,
  weatherCodeToInfo,
  getZimbabweSeason,
  windDirection,
  uvLevel,
  type HourlyWeather,
} from "./weather";

// Helper to build hourly data for frost testing
function makeHourlyData(temps: number[], hours?: number[]): HourlyWeather {
  const baseDate = new Date("2025-06-15T00:00:00"); // Winter in Zimbabwe
  const times = temps.map((_, i) => {
    const d = new Date(baseDate);
    d.setHours(hours ? hours[i] : i);
    return d.toISOString();
  });

  return {
    time: times,
    temperature_2m: temps,
    relative_humidity_2m: temps.map(() => 50),
    precipitation_probability: temps.map(() => 0),
    precipitation: temps.map(() => 0),
    weather_code: temps.map(() => 0),
    visibility: temps.map(() => 10000),
    wind_speed_10m: temps.map(() => 5),
    uv_index: temps.map(() => 1),
    is_day: temps.map(() => 0),
  };
}

describe("checkFrostRisk", () => {
  it("returns null when no temperatures are below 3°C", () => {
    const hourly = makeHourlyData([10, 8, 7, 6, 5, 4, 5, 6, 8, 10, 12, 15]);
    expect(checkFrostRisk(hourly)).toBeNull();
  });

  it("detects severe frost (below 0°C) during nighttime hours", () => {
    // Hours 0-7 (nighttime)
    const temps = [-2, -3, -1, 0, 1, 2, 3, 5, 10, 15, 18, 20];
    const hours = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 15, 18];
    const hourly = makeHourlyData(temps, hours);
    const alert = checkFrostRisk(hourly);

    expect(alert).not.toBeNull();
    expect(alert!.risk).toBe("severe");
    expect(alert!.lowestTemp).toBe(-3);
    expect(alert!.message).toContain("Severe frost warning");
  });

  it("detects high frost risk (0-2°C) during nighttime hours", () => {
    const temps = [2, 1, 1.5, 2, 3, 5, 8, 10, 15, 20, 22, 18];
    const hours = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 15, 18];
    const hourly = makeHourlyData(temps, hours);
    const alert = checkFrostRisk(hourly);

    expect(alert).not.toBeNull();
    expect(alert!.risk).toBe("high");
  });

  it("detects moderate frost risk (2-3°C) during nighttime hours", () => {
    const temps = [3, 2.5, 3, 3, 4, 5, 8, 10, 15, 20, 22, 18];
    const hours = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 15, 18];
    const hourly = makeHourlyData(temps, hours);
    const alert = checkFrostRisk(hourly);

    expect(alert).not.toBeNull();
    expect(alert!.risk).toBe("moderate");
  });

  it("ignores cold temps during daytime (9am-9pm)", () => {
    const temps = [15, 14, 13, 12, 11, 10, 9, 10, 11, 2, 1, 0];
    const hours = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const hourly = makeHourlyData(temps, hours);
    // Hours 18-20 are 6pm-8pm which is within the check range only if >= 22 or <= 8
    // 18, 19, 20 are NOT in the frost check range
    expect(checkFrostRisk(hourly)).toBeNull();
  });

  it("detects frost at 10pm (hour 22)", () => {
    const temps = [15, 10, 2];
    const hours = [20, 21, 22];
    const hourly = makeHourlyData(temps, hours);
    const alert = checkFrostRisk(hourly);

    expect(alert).not.toBeNull();
    // 2°C is <= 2, so classified as "high" risk per checkFrostRisk logic
    expect(alert!.risk).toBe("high");
  });
});

describe("weatherCodeToInfo", () => {
  it("returns Clear sky for code 0", () => {
    const info = weatherCodeToInfo(0);
    expect(info.label).toBe("Clear sky");
    expect(info.icon).toBe("sun");
  });

  it("returns Partly cloudy for code 2", () => {
    const info = weatherCodeToInfo(2);
    expect(info.label).toBe("Partly cloudy");
    expect(info.icon).toBe("cloud-sun");
  });

  it("returns Moderate rain for code 63", () => {
    const info = weatherCodeToInfo(63);
    expect(info.label).toBe("Moderate rain");
    expect(info.icon).toBe("cloud-rain");
  });

  it("returns Thunderstorm for code 95", () => {
    const info = weatherCodeToInfo(95);
    expect(info.label).toBe("Thunderstorm");
    expect(info.icon).toBe("cloud-lightning");
  });

  it("returns Fog for code 45", () => {
    expect(weatherCodeToInfo(45).label).toBe("Fog");
  });

  it("returns Slight snow for code 71", () => {
    expect(weatherCodeToInfo(71).label).toBe("Slight snow");
  });

  it("returns Unknown for unrecognized codes", () => {
    const info = weatherCodeToInfo(999);
    expect(info.label).toBe("Unknown");
    expect(info.icon).toBe("cloud");
  });

  it("handles all documented WMO codes", () => {
    const knownCodes = [0, 1, 2, 3, 45, 48, 51, 53, 55, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];
    for (const code of knownCodes) {
      const info = weatherCodeToInfo(code);
      expect(info.label).not.toBe("Unknown");
      expect(info.icon).toBeTruthy();
    }
  });
});

describe("getZimbabweSeason", () => {
  it("returns Main rains (Masika) for November", () => {
    const season = getZimbabweSeason(new Date("2025-11-15"));
    expect(season.name).toBe("Main rains");
    expect(season.shona).toBe("Masika");
  });

  it("returns Main rains (Masika) for January", () => {
    const season = getZimbabweSeason(new Date("2025-01-15"));
    expect(season.name).toBe("Main rains");
    expect(season.shona).toBe("Masika");
  });

  it("returns Main rains (Masika) for March", () => {
    const season = getZimbabweSeason(new Date("2025-03-15"));
    expect(season.name).toBe("Main rains");
  });

  it("returns Short rains (Munakamwe) for April", () => {
    const season = getZimbabweSeason(new Date("2025-04-15"));
    expect(season.name).toBe("Short rains");
    expect(season.shona).toBe("Munakamwe");
  });

  it("returns Cool dry (Chirimo) for May-August", () => {
    for (const month of [5, 6, 7, 8]) {
      const season = getZimbabweSeason(new Date(`2025-${month.toString().padStart(2, "0")}-15`));
      expect(season.name).toBe("Cool dry");
      expect(season.shona).toBe("Chirimo");
    }
  });

  it("returns Hot dry (Zhizha) for September-October", () => {
    for (const month of [9, 10]) {
      const season = getZimbabweSeason(new Date(`2025-${month.toString().padStart(2, "0")}-15`));
      expect(season.name).toBe("Hot dry");
      expect(season.shona).toBe("Zhizha");
    }
  });

  it("returns Main rains for December", () => {
    const season = getZimbabweSeason(new Date("2025-12-15"));
    expect(season.name).toBe("Main rains");
  });

  it("all seasons have descriptions", () => {
    for (let m = 1; m <= 12; m++) {
      const season = getZimbabweSeason(new Date(`2025-${m.toString().padStart(2, "0")}-15`));
      expect(season.description).toBeTruthy();
    }
  });

  it("uses current date when no argument is provided", () => {
    const season = getZimbabweSeason();
    expect(season.name).toBeTruthy();
    expect(season.shona).toBeTruthy();
    expect(season.description).toBeTruthy();
  });
});

describe("windDirection", () => {
  it("returns N for 0 degrees", () => {
    expect(windDirection(0)).toBe("N");
  });

  it("returns E for 90 degrees", () => {
    expect(windDirection(90)).toBe("E");
  });

  it("returns S for 180 degrees", () => {
    expect(windDirection(180)).toBe("S");
  });

  it("returns W for 270 degrees", () => {
    expect(windDirection(270)).toBe("W");
  });

  it("returns N for 360 degrees (wraps around)", () => {
    expect(windDirection(360)).toBe("N");
  });

  it("returns NE for 45 degrees", () => {
    expect(windDirection(45)).toBe("NE");
  });

  it("returns SE for 135 degrees", () => {
    expect(windDirection(135)).toBe("SE");
  });

  it("returns NW for 315 degrees", () => {
    expect(windDirection(315)).toBe("NW");
  });

  it("returns SW for 225 degrees", () => {
    expect(windDirection(225)).toBe("SW");
  });
});

describe("uvLevel", () => {
  it("returns Low for UV index 0-2", () => {
    expect(uvLevel(0).label).toBe("Low");
    expect(uvLevel(1).label).toBe("Low");
    expect(uvLevel(2).label).toBe("Low");
  });

  it("returns Moderate for UV index 3-5", () => {
    expect(uvLevel(3).label).toBe("Moderate");
    expect(uvLevel(4).label).toBe("Moderate");
    expect(uvLevel(5).label).toBe("Moderate");
  });

  it("returns High for UV index 6-7", () => {
    expect(uvLevel(6).label).toBe("High");
    expect(uvLevel(7).label).toBe("High");
  });

  it("returns Very High for UV index 8-10", () => {
    expect(uvLevel(8).label).toBe("Very High");
    expect(uvLevel(10).label).toBe("Very High");
  });

  it("returns Extreme for UV index above 10", () => {
    expect(uvLevel(11).label).toBe("Extreme");
    expect(uvLevel(15).label).toBe("Extreme");
  });

  it("all levels have a color class", () => {
    for (const idx of [0, 3, 6, 8, 11]) {
      expect(uvLevel(idx).color).toMatch(/^text-/);
    }
  });
});
