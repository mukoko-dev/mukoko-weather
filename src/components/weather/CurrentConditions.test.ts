/**
 * Tests for CurrentConditions — validates the iOS-style centred hero, the
 * share button, and accessibility attributes by reading the source file
 * (Vitest runs in Node without a DOM/React renderer).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "CurrentConditions.tsx"),
  "utf-8",
);

describe("CurrentConditions — client component", () => {
  it("is a client component with 'use client' directive", () => {
    expect(source).toContain('"use client"');
  });

  it("exports CurrentConditions as a named function", () => {
    expect(source).toContain("export function CurrentConditions");
  });
});

describe("CurrentConditions — centred hero structure", () => {
  it("renders the place name as the section heading (no duplicate h1)", () => {
    expect(source).toContain('<h2\n          id="current-conditions-heading"');
    expect(source).not.toContain("<h1");
  });

  it("labels the section by the visible place-name heading", () => {
    expect(source).toContain('aria-labelledby="current-conditions-heading"');
  });

  it("sets the temperature in Noto Serif display, semibold, with tabular figures", () => {
    // Brand doctrine: temperature is Noto Serif (font-heading), never a thin
    // system numeral. layout.tsx loads Noto Serif 400/600/700 — 600 is used.
    expect(source).toContain(
      "font-heading text-8xl font-semibold tabular-nums",
    );
    expect(source).not.toMatch(/font-(thin|extralight|light)\b/);
    expect(source).not.toContain("font-sans text-8xl");
  });

  it("renders the temperature on the sky plate, not a translucent card", () => {
    expect(source).toContain("kori");
    expect(source).toContain("PLATE_CLASS[family]");
    expect(source).not.toMatch(/backdrop-blur|bg-white\/|glass/);
  });

  it("renders the temperature with an accessible degrees-Celsius label", () => {
    expect(source).toContain("degrees Celsius");
    expect(source).toContain('className="sr-only"');
  });

  it("renders the condition label and the high/low line", () => {
    expect(source).toContain("{info.label}");
    expect(source).toContain("formatHighLow(");
  });

  it("does not render the big condition icon in the hero", () => {
    expect(source).not.toContain("WeatherIcon");
    expect(source).not.toContain("nightIcon");
  });

  it("derives the plate family from the WMO code and is_day", () => {
    expect(source).toContain("plateFamily(current.weather_code, isDay)");
    expect(source).toContain("current.is_day === 1");
  });

  it("reads the clock only after mount, in the LOCATION's offset", () => {
    expect(source).toContain("requestAnimationFrame(() => setNow(new Date()))");
    expect(source).toContain(
      "now ? heroOutlook(hourly, now, utcOffsetSeconds) : null",
    );
  });

  it("renders the one-sentence outlook from the hourly series, with no AI call", () => {
    expect(source).toContain("heroOutlook(hourly, now, utcOffsetSeconds)");
    expect(source).not.toMatch(/\/api\/py\/ai|fetch\(\s*["'`]\/api\/py\/ai/);
  });

  it("shows the top selected activity's rating through the activity clause helper", () => {
    expect(source).toContain("selectedActivities");
    expect(source).toContain(
      "feasibilitySeries(activity, hourly, dbRules, 24, utcOffsetSeconds, now)",
    );
    expect(source).toContain("heroActivityClause(");
    // The clause labels hours in the location's zone too.
    expect(source).toContain("utcOffsetSeconds,\n      );");
    expect(source).toContain("activityDotClass(activity.category)");
  });

  it("offers a quiet pick-activities button when nothing is selected", () => {
    expect(source).toContain('openMyWeather("activities")');
    expect(source).toContain("Pick activities for tailored advice");
    expect(source).toContain("!hasSelection");
  });

  it("does not render the feels-like line (moved to the metric cards)", () => {
    expect(source).not.toContain("Feels like");
    expect(source).not.toContain("apparent_temperature");
  });

  it("does not render inline stat boxes (consolidated into AtmosphericSummary)", () => {
    expect(source).not.toContain("QuickStat");
    expect(source).not.toContain('role="list"');
    expect(source).not.toContain('role="listitem"');
  });

  it("uses no hardcoded colours or inline styles", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toContain("style={{");
    expect(source).not.toMatch(/rgba?\(/);
  });

  it("renders a footer slot below the sky plate (season line)", () => {
    expect(source).toContain("footer?: ReactNode");
    expect(source).toContain("{footer && (");
    // The footer sits after the plate closes, outside the solid surface.
    expect(source.indexOf("{footer && (")).toBeGreaterThan(
      source.indexOf("className={`kori"),
    );
  });
});

describe("CurrentConditions — share button", () => {
  it("imports ShareIcon from weather-icons", () => {
    expect(source).toContain("ShareIcon");
    expect(source).toContain("weather-icons");
  });

  it("accepts a slug prop for constructing share URLs", () => {
    expect(source).toContain("slug?:");
  });

  it("defines a handleShare function", () => {
    expect(source).toContain("handleShare");
  });

  it("uses Web Share API (navigator.share) when available", () => {
    expect(source).toContain("navigator.share");
  });

  it("falls back to clipboard copy when Web Share API is unavailable", () => {
    expect(source).toMatch(/navigator\.clipboard\s*\.writeText/);
  });

  it("shows 'Copied!' feedback state after clipboard copy", () => {
    expect(source).toContain("Copied!");
    expect(source).toContain("setCopied");
  });

  it("resets copied state after 2 seconds", () => {
    expect(source).toContain("2000");
    expect(source).toContain("setTimeout");
  });

  it("constructs share URL from BASE_URL and slug", () => {
    expect(source).toContain("BASE_URL");
    expect(source).toContain("weather.mukoko.com");
  });

  it("falls back to window.location.href when slug is not provided", () => {
    expect(source).toContain("window.location.href");
  });

  it("sits below the high/low line, centred", () => {
    const shareIdx = source.indexOf("handleShare}");
    const hlIdx = source.indexOf("{highLow && (");
    expect(hlIdx).toBeGreaterThan(-1);
    expect(shareIdx).toBeGreaterThan(hlIdx);
  });
});

describe("CurrentConditions — share button accessibility", () => {
  it("share button has aria-label describing the action", () => {
    expect(source).toContain("Share weather for");
    expect(source).toContain("aria-label");
  });

  it("share button is the .impala-plate pill (carries the touch-target minimums)", () => {
    expect(source).toContain('className="impala-plate mt-3"');
  });

  it("the activities CTA is the .kudu-plate Mzizi pill, not a hand-rolled box", () => {
    expect(source).toContain('className="kudu-plate mt-4"');
    expect(source).not.toContain("border border-current");
  });

  it("the plate spans the main column with no horizontal inset", () => {
    expect(source).toContain('className="relative"');
    expect(source).not.toContain("px-3 sm:px-6");
  });

  it("ShareIcon is aria-hidden to avoid duplicate label", () => {
    expect(source).toContain('aria-hidden="true"');
  });

  it("share button text is sr-only on small screens and visible on sm+", () => {
    expect(source).toContain("sr-only sm:not-sr-only");
  });
});

describe("CurrentConditions — temperature accessibility", () => {
  it("temperature display has aria-hidden visual number and sr-only unit label", () => {
    expect(source).toContain("degrees Celsius");
    expect(source).toContain('aria-hidden="true"');
  });
});

describe("CurrentConditions — section accessibility", () => {
  it("wraps content in a <section> with aria-labelledby", () => {
    expect(source).toContain("aria-labelledby");
    expect(source).toContain("current-conditions-heading");
  });
});

describe("CurrentConditions — eyebrow (MY LOCATION / HOME)", () => {
  it("renders the eyebrow only when at least one badge applies", () => {
    expect(source).toContain("badges.length > 0");
  });

  it("selects badges through the hero helpers, not inline logic", () => {
    expect(source).toContain("heroEyebrowBadges(");
    expect(source).toContain("isHomeLocation(slug, homeLocation)");
  });

  it("keeps the isCurrentLocation prop, defaulting off so /{slug} pages are unaffected", () => {
    expect(source).toContain("isCurrentLocation?: boolean");
    expect(source).toContain("isCurrentLocation = false");
  });

  it("reads homeLocation from the store defensively (field added by another agent)", () => {
    expect(source).toContain("useAppStore");
    expect(source).toContain(
      "(s as { homeLocation?: string | null }).homeLocation ?? null",
    );
  });

  it("uses the shared heroBadgeLabel for the label text", () => {
    expect(source).toContain("heroBadgeLabel(badge)");
  });
});
