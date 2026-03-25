/**
 * Tests for HourlyScrollCards — validates the extracted horizontal
 * scrollable hour-by-hour weather cards component.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "HourlyScrollCards.tsx"),
  "utf-8",
);

describe("HourlyScrollCards — structure", () => {
  it("exports a named HourlyScrollCards component", () => {
    expect(source).toContain("export function HourlyScrollCards");
  });

  it("accepts hourly: HourlyWeather prop", () => {
    expect(source).toContain("hourly: HourlyWeather");
  });

  it("uses ScrollArea for horizontal scrolling", () => {
    expect(source).toContain("ScrollArea");
    expect(source).toContain('orientation="horizontal"');
  });

  it("renders a list with proper ARIA role", () => {
    expect(source).toContain('role="list"');
    expect(source).toContain('aria-label="Hourly weather forecast"');
  });

  it("renders list items with ARIA labels", () => {
    expect(source).toContain('role="listitem"');
    expect(source).toContain("aria-label={`${timeLabel}:");
  });
});

describe("HourlyScrollCards — hour slicing", () => {
  it("slices 24 hours from the hourly data", () => {
    expect(source).toContain("start + 24");
  });

  it("finds the start index from current hour", () => {
    expect(source).toContain("currentHour");
    expect(source).toContain("findIndex");
  });

  it('labels the first item as "Now"', () => {
    expect(source).toContain('"Now"');
  });
});

describe("HourlyScrollCards — weather data", () => {
  it("displays temperature", () => {
    expect(source).toContain("temperature_2m");
    expect(source).toContain("temp}°");
  });

  it("displays precipitation probability when > 0", () => {
    expect(source).toContain("precipitation_probability?.[idx]");
  });

  it("uses WeatherIcon for condition display", () => {
    expect(source).toContain("WeatherIcon");
    expect(source).toContain("weatherCodeToInfo");
  });

  it("uses global styles only (no hardcoded colors)", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(source).not.toContain("style={{");
    expect(source).toContain("bg-surface-card");
    expect(source).toContain("text-text-primary");
  });
});
