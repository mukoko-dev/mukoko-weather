/**
 * Tests for CurrentConditions — the open-sky hero (no card): structure, share
 * control and accessibility, by reading the source file. Rendered output is
 * covered in CurrentConditions.render.test.ts.
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

describe("CurrentConditions — open-sky hero structure", () => {
  it("renders the place name as the section heading (no duplicate h1)", () => {
    expect(source).toContain('id="current-conditions-heading"');
    expect(source).not.toContain("<h1");
  });

  it("labels the section by the visible place-name heading", () => {
    expect(source).toContain('aria-labelledby="current-conditions-heading"');
  });

  it("sets the temperature in Noto Serif display, semibold, with tabular figures", () => {
    // Brand doctrine: temperature is Noto Serif (font-heading), never a thin
    // system numeral. layout.tsx loads Noto Serif 400/600/700 — 600 is used.
    expect(source).toContain(
      "font-heading text-[clamp(5rem,26vw,6.5rem)] leading-[0.95] font-semibold tabular-nums",
    );
    expect(source).not.toMatch(/font-(thin|extralight|light)\b/);
    expect(source).not.toMatch(/font-sans text-\[/);
  });

  it("paints the open sky (a .kestrel band), not a card or glass", () => {
    expect(source).toContain("kestrel ${SKY_CLASS[family]}");
    expect(source).toContain("data-sky-hero");
    expect(source).not.toMatch(/backdrop-blur|bg-white\/|glass|\bkori\b/);
    expect(source).not.toMatch(/baobab|acacia|shadow-/);
  });

  it("is left-aligned, not centred", () => {
    expect(source).toContain("text-left");
    expect(source).not.toMatch(/items-center text-center|justify-center text-center/);
  });

  it("keeps the band decorative and the content in the page column", () => {
    const band = source.slice(source.indexOf("<div\n        aria-hidden"));
    expect(band.startsWith('<div\n        aria-hidden="true"')).toBe(true);
  });

  it("renders the temperature with an accessible degrees-Celsius label", () => {
    expect(source).toContain("degrees Celsius");
    expect(source).toContain('className="sr-only"');
  });

  it("renders the condition label and the high/low line", () => {
    expect(source).toContain("{info.label}");
    expect(source).toContain("formatHighLow(");
  });

  it("shows a decorative 56px condition icon, day or night", () => {
    expect(source).toContain("<WeatherIcon");
    expect(source).toContain("nightIcon(info.icon)");
    expect(source).toContain("size={56}");
    expect(source).toContain('<span aria-hidden="true" className="shrink-0">');
  });

  it("derives the sky family from the WMO code and is_day", () => {
    expect(source).toContain("skyFamily(current.weather_code, isDay)");
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

  it("demotes pick-activities to a quiet underlined text link (still a control)", () => {
    expect(source).toContain('className="kestrel-link mt-1"');
    expect(source).not.toContain("kudu-plate");
    expect(source).toContain('openMyWeather("activities")');
    expect(source).toContain("Pick activities for tailored advice");
    expect(source).toContain("!hasSelection");
  });

  it("shows 'Feels N°' beside the high/low through the pure helper", () => {
    expect(source).toContain("formatFeelsLike(current.apparent_temperature)");
    expect(source).toContain("flex-wrap");
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

  it("renders a footer slot at the foot of the sky (season line)", () => {
    expect(source).toContain("footer?: ReactNode");
    expect(source).toContain("{footer && ");
  });

  it("reserves the sky fade below its content so the hourly panel can overlap it", () => {
    expect(source).toContain("pb-[var(--sky-fade)]");
  });

  it("honours left/right safe areas", () => {
    expect(source).toContain("env(safe-area-inset-left");
    expect(source).toContain("env(safe-area-inset-right");
  });

  it("scales with Dynamic Type: rem sizes, wrapping H/L row, no fixed heights", () => {
    expect(source).not.toMatch(/\bh-\[\d+px\]|truncate|line-clamp/);
    expect(source).toContain("break-words");
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

  it("announces 'Link copied' after clipboard copy (live region)", () => {
    expect(source).toContain("Link copied");
    expect(source).toContain('role="status"');
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

  it("sits at the top-right of the hero, before the temperature", () => {
    const shareIdx = source.indexOf("handleShare}");
    const tempIdx = source.indexOf("{temperature}");
    expect(shareIdx).toBeGreaterThan(-1);
    expect(shareIdx).toBeLessThan(tempIdx);
  });
});

describe("CurrentConditions — share button accessibility", () => {
  it("share button has aria-label describing the action", () => {
    expect(source).toContain("Share weather for");
    expect(source).toContain("aria-label");
  });

  it("share is the round 48px .kestrel-round icon control", () => {
    expect(source).toContain('className="kestrel-round"');
    expect(source).not.toContain("impala-plate");
  });

  it("the hero content sits flush with the page column (no horizontal padding)", () => {
    expect(source).not.toMatch(/\bpx-\d|sm:px-/);
  });

  it("ShareIcon is aria-hidden to avoid duplicate label", () => {
    expect(source).toContain('aria-hidden="true"');
  });

  it("share is icon-only: its name comes from aria-label", () => {
    expect(source).not.toContain("sr-only sm:not-sr-only");
    expect(source).toContain("Share weather for");
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
