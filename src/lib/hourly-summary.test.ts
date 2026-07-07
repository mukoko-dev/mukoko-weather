import { describe, it, expect } from "vitest";
import {
  hourlySummary,
  conditionGroup,
  SUMMARY_LOOKAHEAD_HOURS,
  GUST_MENTION_KMH,
} from "./hourly-summary";
import type { HourlyWeather } from "./weather";

function makeHourly(codes: number[], gusts?: number[]): HourlyWeather {
  const start = new Date();
  start.setHours(8, 0, 0, 0); // deterministic hour labels
  return {
    time: codes.map((_, i) => new Date(start.getTime() + i * 3600_000).toISOString()),
    weather_code: codes,
    wind_gusts_10m: gusts ?? codes.map(() => 10),
  } as unknown as HourlyWeather;
}

describe("conditionGroup", () => {
  it("maps WMO codes to coarse groups", () => {
    expect(conditionGroup(0)).toBe("clear");
    expect(conditionGroup(2)).toBe("partly cloudy");
    expect(conditionGroup(3)).toBe("cloudy");
    expect(conditionGroup(45)).toBe("foggy");
    expect(conditionGroup(53)).toBe("drizzly");
    expect(conditionGroup(63)).toBe("rainy");
    expect(conditionGroup(81)).toBe("rainy");
    expect(conditionGroup(73)).toBe("snowy");
    expect(conditionGroup(95)).toBe("stormy");
  });
});

describe("hourlySummary", () => {
  it("announces the first condition change with its hour", () => {
    // clear now, rain arriving at index 3 (start hour 08:00 → 11:00)
    const codes = [0, 0, 0, 63, 63, 63, 63, 63, 63, 63, 63, 63];
    const summary = hourlySummary(makeHourly(codes), 0);
    expect(summary).toContain("Rain expected around 11:00.");
  });

  it("reports continuation when nothing changes in the window", () => {
    const codes = Array(14).fill(3);
    const summary = hourlySummary(makeHourly(codes), 0);
    expect(summary).toContain(`Cloudy conditions will continue for the next ${SUMMARY_LOOKAHEAD_HOURS} hours.`);
  });

  it("ignores fine-grained changes within the same group", () => {
    // slight rain → moderate rain → heavy rain: all "rainy", no change reported
    const codes = [61, 63, 65, 63, 61, 63, 65, 63, 61, 63, 65, 63];
    const summary = hourlySummary(makeHourly(codes), 0);
    expect(summary).toContain("will continue");
  });

  it("adds the gust clause when peak gusts reach the threshold", () => {
    const codes = Array(12).fill(0);
    const gusts = Array(12).fill(10);
    gusts[4] = 26.4;
    const summary = hourlySummary(makeHourly(codes, gusts), 0);
    expect(summary).toContain("Wind gusts are up to 26 km/h.");
  });

  it("omits the gust clause below the threshold", () => {
    const codes = Array(12).fill(0);
    const gusts = Array(12).fill(GUST_MENTION_KMH - 1);
    const summary = hourlySummary(makeHourly(codes, gusts), 0);
    expect(summary).not.toContain("Wind gusts");
  });

  it("respects the start index (same slicing as the strip)", () => {
    // change is at absolute index 6; starting at 5 it's 1 hour ahead (13:00 for 08:00 base)
    const codes = [0, 0, 0, 0, 0, 0, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95, 95];
    const summary = hourlySummary(makeHourly(codes), 5);
    expect(summary).toContain("Thunderstorms expected around 14:00.");
  });

  it("returns null on missing or insufficient data", () => {
    expect(hourlySummary(makeHourly([]), 0)).toBeNull();
    expect(hourlySummary(makeHourly([0]), 0)).toBeNull();
    expect(hourlySummary(makeHourly(Array(12).fill(0)), -1)).toBeNull();
    expect(hourlySummary(makeHourly(Array(12).fill(0)), 99)).toBeNull();
  });
});
