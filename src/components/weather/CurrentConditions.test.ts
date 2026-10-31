/**
 * Tests for CurrentConditions — the open-sky hero (no card, centred stack over
 * the page sky): structure, top row, share control and accessibility, by
 * reading the source file. Rendered output is covered in
 * CurrentConditions.render.test.ts.
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

describe("CurrentConditions — hero stack (matches the owner's mockup)", () => {
  it("renders the place name as the section heading (no duplicate h1)", () => {
    expect(source).toContain('id="current-conditions-heading"');
    expect(source).not.toContain("<h1");
    expect(source).toContain('aria-labelledby="current-conditions-heading"');
  });

  it("sets the place name in Noto Serif at Mzizi H2 (36px / 1.2, weight 600)", () => {
    expect(source).toContain(
      "font-heading text-[length:var(--text-h2)] leading-[var(--text-h2-leading)] font-semibold",
    );
  });

  it("sets the temperature in Noto Sans at Mzizi Display (72px / 1.1), weight 400, tabular figures", () => {
    expect(source).toContain(
      "font-sans text-[length:var(--text-display)] leading-[var(--text-display-leading)] font-normal tracking-tight tabular-nums",
    );
    expect(source).not.toMatch(/font-(thin|extralight|light)\b/);
  });

  it("renders the temperature with an accessible degrees-Celsius label", () => {
    expect(source).toContain("degrees Celsius");
    expect(source).toContain('className="sr-only"');
  });

  it("is a centred stack, not left-aligned", () => {
    expect(source).toContain("items-center pt-4 pb-[26px] text-center");
    expect(source).not.toContain("text-left");
  });

  it("shows the condition at 20px with a small decorative glyph before it, day or night", () => {
    expect(source).toContain("<WeatherIcon");
    expect(source).toContain("nightIcon(info.icon)");
    expect(source).toContain("size={20}");
    expect(source).toContain(
      "text-[length:var(--text-h5)] leading-[var(--text-h5-leading)] font-normal",
    );
    expect(source).toContain('<span aria-hidden="true" className="shrink-0">');
    expect(source).not.toContain("size={56}");
  });

  it("shows H:/L: at Mzizi Body Large (18px, weight 600) in the dimmer sky white, wrapping between the parts", () => {
    expect(source).toContain("formatHighLowParts(");
    expect(source).toContain(
      "text-[length:var(--text-body-lg)] leading-[var(--text-body-lg-leading)] font-semibold",
    );
    expect(source).toContain("text-[var(--sky-fg-dim)]");
    expect(source).toContain("flex-wrap");
  });

  it("keeps the hero to eyebrow, name, numeral, condition and H/L: no outlook, no feels-like, no CTA", () => {
    expect(source).not.toContain("heroOutlook");
    expect(source).not.toContain("apparent_temperature");
    expect(source).not.toContain("Pick activities");
    expect(source).not.toContain("openMyWeather");
  });

  it("reads the eyebrow clock only after mount, in the LOCATION's offset", () => {
    expect(source).toContain("requestAnimationFrame(() => setNow(new Date()))");
    expect(source).toContain("heroLocalTime(now, utcOffsetSeconds)");
    // The line is always reserved, so the clock arriving never shifts the page.
    expect(source).toContain(
      "min-h-[calc(var(--text-caption)*var(--text-caption-leading))]",
    );
  });

  it("is the sky hero: no card, no glass, no shadow, no inline style", () => {
    expect(source).toContain("data-sky-hero");
    expect(source).not.toMatch(
      /baobab|acacia|backdrop-blur|bg-white\/|glass|shadow-/,
    );
    expect(source).not.toMatch(/\bkori\b/);
    expect(source).not.toContain("style={{");
  });

  it("uses no hardcoded colours", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/rgba?\(/);
  });

  it("keeps the activity clause as one quiet line when activities are selected", () => {
    expect(source).toContain("selectedActivities");
    expect(source).toContain(
      "feasibilitySeries(activity, hourly, dbRules, 24, utcOffsetSeconds, now)",
    );
    expect(source).toContain("heroActivityClause(");
    expect(source).toContain("activityDotClass(activity.category)");
  });

  it("has no footer slot: the season line lives in the Conditions card", () => {
    expect(source).not.toContain("footer");
  });

  it("scales with Dynamic Type: rem sizes, wrapping rows, no fixed heights or truncation", () => {
    expect(source).not.toMatch(/\bh-\[\d+px\]|truncate|line-clamp/);
    expect(source).toContain("break-words");
    expect(source).toContain("max-w-full");
  });

  it("honours left/right safe areas", () => {
    expect(source).toContain("env(safe-area-inset-left");
    expect(source).toContain("env(safe-area-inset-right");
  });

  it("does not render inline stat boxes (consolidated into AtmosphericSummary)", () => {
    expect(source).not.toContain("QuickStat");
    expect(source).not.toContain('role="list"');
    expect(source).not.toContain('role="listitem"');
  });
});

describe("CurrentConditions — top row (breadcrumb, Share, ⋯)", () => {
  it("takes the breadcrumb as a slot at the left of the top row, Body Small 14px, dim sky white", () => {
    expect(source).toContain("breadcrumb?: ReactNode");
    expect(source).toContain("{breadcrumb}");
    expect(source).toContain(
      "text-[length:var(--text-body-sm)] leading-[var(--text-body-sm-leading)] text-[var(--sky-fg-dim)]",
    );
  });

  it("holds Share and, on phones only, the ⋯ menu — both round 48px controls", () => {
    expect(source).toContain('className="kestrel-round"');
    expect(source).toContain("<PhoneMenu");
    expect(source).toContain('buttonClassName="kestrel-round"');
    expect(source).toContain('<div className="relative sm:hidden">');
  });

  it("sits before the identity stack", () => {
    expect(source.indexOf("kestrel-round")).toBeLessThan(
      source.indexOf("{temperature}"),
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

  it("constructs share URL from BASE_URL and slug, else window.location.href", () => {
    expect(source).toContain("BASE_URL");
    expect(source).toContain("weather.mukoko.com");
    expect(source).toContain("window.location.href");
  });

  it("is icon-only: its name comes from aria-label", () => {
    expect(source).toContain("Share weather for");
    expect(source).toContain("aria-label");
    expect(source).not.toContain("sr-only sm:not-sr-only");
  });

  it("hides its icon from assistive tech to avoid a duplicate label", () => {
    expect(source).toContain('aria-hidden="true"');
  });
});

describe("CurrentConditions — eyebrow (MY LOCATION / HOME / local time)", () => {
  it("selects badges through the hero helpers, not inline logic", () => {
    expect(source).toContain("heroEyebrowBadges(");
    expect(source).toContain("isHomeLocation(slug, homeLocation)");
  });

  it("separates two badges with a dot", () => {
    expect(source).toContain("{i > 0 && <span");
  });

  it("falls back to the place's own clock when no badge applies", () => {
    expect(source).toContain(": localTime}");
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
