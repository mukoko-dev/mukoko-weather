import { describe, expect, it } from "vitest";
import {
  cloudBaseKm,
  convectiveProxy,
  dewPointC,
  growingDegreeDays,
  heatIndexC,
  moonPhase,
} from "./derived-insights";
import { createFallbackWeather, synthesizeOpenMeteoInsights } from "./weather";

// Same reference vectors as tests/py/test_insights.py — the two
// implementations must agree (issue #246).

describe("derived-insights helpers (parity with api/py/_insights.py)", () => {
  it("dew point (Magnus)", () => {
    expect(dewPointC(20, 100)).toBeCloseTo(20, 1);
    expect(dewPointC(25, 50)).toBeCloseTo(13.9, 0);
    expect(dewPointC(null, 50)).toBeUndefined();
  });

  it("heat index (NOAA Rothfusz)", () => {
    expect(heatIndexC(22, 80)).toBe(22);
    expect(Math.abs((heatIndexC(32, 70) ?? 0) - 40.4)).toBeLessThan(0.6);
    expect(heatIndexC(38, 10)!).toBeLessThan(38);
  });

  it("growing degree days clamp base and cap", () => {
    expect(growingDegreeDays(28, 14, 10, 30)).toBe(11);
    expect(growingDegreeDays(35, 5, 10, 30)).toBe(10);
    expect(growingDegreeDays(9, 2, 10, 30)).toBe(0);
  });

  it("convective proxy thresholds", () => {
    expect(convectiveProxy(3000, null)).toBe(60);
    expect(convectiveProxy(null, -7)).toBe(60);
    expect(convectiveProxy(1200, null)).toBe(40);
    expect(convectiveProxy(600, 0)).toBe(20);
    expect(convectiveProxy(100, 2)).toBe(0);
    expect(convectiveProxy(undefined, undefined)).toBe(0);
  });

  it("moon phase (0 new … 4 full)", () => {
    expect(moonPhase(new Date(Date.UTC(2000, 0, 6, 18, 14)))).toBe(0);
    expect(moonPhase(new Date(Date.UTC(2024, 0, 25, 18)))).toBe(4);
  });

  it("cloud base from the LCL", () => {
    expect(cloudBaseKm(25, 15, 60)).toBe(1.25);
    expect(cloudBaseKm(25, 15, 5)).toBeUndefined();
  });
});

describe("synthesizeOpenMeteoInsights derives every rule field", () => {
  function hotStormyDay() {
    const data = createFallbackWeather(-17.83, 31.05, 1483);
    data.current.temperature_2m = 32;
    data.current.relative_humidity_2m = 60;
    data.current.cloud_cover = 70;
    data.current.uv_index = 9.1;
    data.daily.temperature_2m_max = data.daily.temperature_2m_max.map(() => 33);
    data.daily.temperature_2m_min = data.daily.temperature_2m_min.map(() => 17);
    data.daily.et0_fao_evapotranspiration = [6.4];
    data.hourly.cape = data.hourly.time.map(() => 2600);
    data.hourly.precipitation_probability = data.hourly.time.map(() => 60);
    return data;
  }

  it("works without Tomorrow.io", () => {
    const ins = synthesizeOpenMeteoInsights(
      hotStormyDay(),
      new Date(Date.UTC(2024, 0, 25, 18)),
    );
    expect(ins.heatStressIndex).toBeGreaterThan(32);
    expect(ins.dewPoint).toBeDefined();
    expect(ins.uvHealthConcern).toBe(9.1);
    expect(ins.thunderstormProbability).toBe(60);
    expect(ins.gdd10To30).toBe(13.5);
    expect(ins.gdd03To25).toBeDefined();
    expect(ins.evapotranspiration).toBe(6.4);
    expect(ins.moonPhase).toBe(4);
    expect(ins.cloudBase).toBeGreaterThan(0);
    expect(ins.cloudCeiling).toBe(ins.cloudBase);
  });

  it("damps the convective proxy when models agree there is no rain", () => {
    const data = hotStormyDay();
    data.hourly.precipitation_probability = data.hourly.time.map(() => 5);
    expect(synthesizeOpenMeteoInsights(data).thunderstormProbability).toBe(30);
  });

  it("has no ceiling under broken-cloud threshold", () => {
    const data = hotStormyDay();
    data.current.cloud_cover = 30;
    expect(synthesizeOpenMeteoInsights(data).cloudCeiling).toBeNull();
  });
});
