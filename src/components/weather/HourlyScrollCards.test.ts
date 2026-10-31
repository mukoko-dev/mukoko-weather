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

  it("finds the start index from the LOCATION's current hour", () => {
    expect(source).toContain("currentHourIndex(hourly.time, offset)");
    expect(source).toContain("resolveOffsetSeconds(utcOffsetSeconds)");
    // Never the viewer's clock.
    expect(source).not.toContain("getHours()");
    expect(source).not.toContain("toLocaleTimeString");
  });

  it("labels hours on the location's clock", () => {
    expect(source).toContain("locationClockLabel(time, offset)");
  });

  it('labels the first item as "Now"', () => {
    expect(source).toContain('"Now"');
  });
});

describe("HourlyScrollCards — deterministic render (no #418)", () => {
  it("gates the wall-clock start index on useHydrated", () => {
    expect(source).toContain("useHydrated");
    // The current-hour slice must only apply once hydrated; SSR + first client
    // render start at index 0 so the HTML matches and there is no text mismatch.
    expect(source).toContain("hydrated");
    expect(source).toContain(
      "start = hydrated ? currentHourIndex(hourly.time, offset) : 0",
    );
  });

  it('only shows the "Now" label after hydration', () => {
    expect(source).toMatch(/hydrated && i === 0\s*\?\s*"Now"/);
  });

  it("is a client component (uses the browser clock)", () => {
    expect(source).toContain('"use client"');
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
    // .baobab fauna class (defined in globals.css) resolves to bg-surface-card + border + shadow
    expect(source).toMatch(/baobab|bg-surface-card/);
    expect(source).toContain("text-text-primary");
  });
});

describe("HourlyScrollCards — the Conditions card owns the outlook", () => {
  it("shows the one-sentence outlook above the hours, hydration-gated, in the place's time", () => {
    expect(source).toContain('from "@/lib/hero"');
    expect(source).toContain(
      "hydrated\n    ? heroOutlook(hourly, new Date(), offset)",
    );
    expect(source).toContain("{outlook && (");
    expect(source.indexOf("{outlook && (")).toBeLessThan(
      source.indexOf("<ScrollArea"),
    );
  });

  it("the hero no longer renders the outlook", () => {
    const hero = readFileSync(
      resolve(__dirname, "CurrentConditions.tsx"),
      "utf-8",
    );
    expect(hero).not.toContain("heroOutlook(");
  });
});

describe("HourlyScrollCards — Conditions card surface", () => {
  it("is the translucent bordered sky card under the hero, an ordinary card elsewhere", () => {
    expect(source).toContain("data-hourly-strip");
    expect(source).toContain('variant === "sky"');
    expect(source).toContain('"kestrel-card overflow-hidden"');
    expect(source).toContain('"baobab overflow-hidden shadow-none"');
  });

  it("does not overlap the sky: no negative margin, no z-index lift", () => {
    expect(source).not.toMatch(/-mt-|z-10|margin-top/);
  });

  it("carries its own heading inside the card, with the forecast link", () => {
    expect(source).toContain("<SectionHeader");
    expect(source).toContain("heading?:");
  });
});
