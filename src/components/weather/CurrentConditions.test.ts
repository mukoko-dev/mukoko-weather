/**
 * Tests for CurrentConditions — the hero: open sky on top (bare text on the
 * page sky, each row on its own line, nothing pulled up over anything) and one
 * data card under it (HeroDataCard): structure, top row, the registration the
 * Quick actions group reads and accessibility, by reading the source file.
 * Rendered output is covered in CurrentConditions.render.test.ts, the card's
 * rows in HeroDataCard.test.ts.
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

describe('CurrentConditions — open sky (the owner-approved "open sky with a data card" design)', () => {
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

  it("is a left-aligned stack, not centred", () => {
    expect(source).toContain('className="pt-4 pb-[26px]"');
    expect(source).not.toContain("text-center");
  });

  it("gives the eyebrow, the name and the country each their own grid row, and the glyph its own column spanning them", () => {
    expect(source).toContain(
      "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 min-[360px]:gap-x-3",
    );
    expect(source).toContain("col-start-1 row-start-1");
    expect(source).toContain("col-start-1 row-start-2");
    expect(source).toContain("col-start-1 row-start-3");
    expect(source).toContain(
      "col-start-2 row-span-3 row-start-1 self-center block size-10 min-[360px]:size-14",
    );
  });

  it("gives a long place name room on a narrow phone: a 40px glyph, the name one step down (H3) under 360px, hyphenation instead of a raw break", () => {
    expect(source).toContain("block size-10 min-[360px]:size-14");
    expect(source).toContain(
      "max-[359px]:text-[length:var(--text-h3)] max-[359px]:leading-[var(--text-h3-leading)]",
    );
    expect(source).toContain("break-words hyphens-auto");
    expect(source).toContain('className="size-full"');
  });

  it("pulls nothing up over text: no negative margin, no transform, no absolute position in the sky", () => {
    const sky = source
      .slice(source.indexOf("<section"), source.indexOf("</section>"))
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(sky).not.toMatch(/(^|[\s"'`:])-m[trblxy]?-/);
    expect(sky).not.toMatch(/-translate|translate-|transform|rotate-|scale-/);
    expect(sky).not.toMatch(/\babsolute\b|\bfixed\b|\bsticky\b/);
    expect(source).not.toMatch(/\bz-\d|\bz-\[/);
  });

  it("shows the condition as text at Mzizi H5 (weight 600) and the glyph at 56px in its own right-hand column, a moon at night", () => {
    expect(source).toContain("<WeatherIcon");
    expect(source).toContain("nightIcon(info.icon)");
    expect(source).toContain("size={56}");
    expect(source).toContain(
      "text-[length:var(--text-h5)] leading-[var(--text-h5-leading)] font-semibold",
    );
    expect(source).not.toContain("size={20}");
  });

  it("shows H:/L: at Mzizi Body Large (18px, weight 600) in the dimmer sky white, wrapping between the parts", () => {
    expect(source).toContain("formatHighLowParts(");
    expect(source).toContain(
      "text-[length:var(--text-body-lg)] leading-[var(--text-body-lg-leading)] font-semibold",
    );
    expect(source).toContain("text-[var(--sky-fg-dim)]");
    expect(source).toContain("flex-wrap");
  });

  it("adds the H / L / Feels line and the one-sentence outlook to the sky, through the shared helpers", () => {
    expect(source).toContain("formatFeelsLike(current.apparent_temperature)");
    expect(source).toContain("heroOutlook(hourly, now, utcOffsetSeconds)");
    // Held at two lines until the client clock is known, so the card below
    // does not move when the sentence arrives.
    expect(source).toContain("holdOutlook");
    expect(source).toContain(
      "min-h-[calc(2*var(--text-body)*var(--text-body-leading))]",
    );
  });

  it("puts everything you scan or tap in the data card, not on the sky: no activities call, no hour strip in this file", () => {
    expect(source).toContain("<HeroDataCard");
    expect(source).not.toContain("openMyWeather");
    expect(source).not.toContain("Add your activities");
    expect(source).not.toContain("heroHourStrip");
  });

  it("reads the eyebrow clock only after mount, in the LOCATION's offset", () => {
    expect(source).toContain("requestAnimationFrame(() => setNow(new Date()))");
    expect(source).toContain("heroLocalTime(now, utcOffsetSeconds)");
    // The line is always reserved, so the clock arriving never shifts the page.
    expect(source).toContain(
      "min-h-[calc(var(--text-caption)*var(--text-caption-leading))]",
    );
  });

  it("the sky stays bare of cards (no surface, glass or shadow, no inline style); the one card is a sibling, so it does not inherit the sky's white text and focus ring", () => {
    expect(source).toContain("data-sky-hero");
    expect(source).not.toMatch(
      /baobab|acacia|backdrop-blur|bg-white\/|glass|shadow-/,
    );
    const sky = source.slice(
      source.indexOf("<section"),
      source.indexOf("</section>"),
    );
    expect(sky).not.toContain("<HeroDataCard");
    expect(source.indexOf("</section>")).toBeLessThan(
      source.indexOf("<HeroDataCard"),
    );
    expect(source).not.toMatch(/\bkori\b/);
    expect(source).not.toContain("style={{");
  });

  it("uses no hardcoded colours", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/rgba?\(/);
  });

  it("keeps the activity clause logic when activities are selected, and hands it to the card's last row", () => {
    expect(source).toContain("selectedActivities");
    expect(source).toContain(
      "feasibilitySeries(activity, hourly, dbRules, 24, utcOffsetSeconds, now)",
    );
    expect(source).toContain("heroActivityClause(");
    expect(source).toContain("activityDotClass(activity.category)");
    expect(source).toContain("hasSelection={hasSelection}");
    expect(source).toContain("activityLine={activityLine}");
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

describe("CurrentConditions — top row (the breadcrumb; the Quick actions group is the layout's)", () => {
  it("takes the breadcrumb as a slot at the left of the top row, Body Small 14px, dim sky white", () => {
    expect(source).toContain("breadcrumb?: ReactNode");
    expect(source).toContain("{breadcrumb}");
    expect(source).toContain(
      "text-[length:var(--text-body-sm)] leading-[var(--text-body-sm-leading)] text-[var(--sky-fg-dim)]",
    );
  });

  it("draws no group of its own: Share, Notifications and Locations are the layout's, one mount for every page", () => {
    expect(source).not.toContain('className="hadeda');
    expect(source).not.toContain("<ShareControl");
    expect(source).not.toContain("<LocationsLink");
    expect(source).not.toContain("<NotificationsButton");
    expect(source).not.toContain("kestrel-round");
    expect(source).not.toContain("PhoneMenu");
    expect(source).not.toContain("<AccountMenu");
  });

  it("keeps the top row 49px tall and leaves the breadcrumb room for the group (three controls wide) on phones", () => {
    expect(source).toContain(
      "min-h-[var(--touch-target-min)] min-w-0 pr-[var(--hadeda-reserve)]",
    );
    expect(source).toContain("sm:pr-0");
  });

  it("registers its first line of content (the eyebrow) and its place as the sky hero, for the group's tone and its Share", () => {
    expect(source).toContain(
      'import { useRegisterSkyHero } from "@/lib/sky-hero"',
    );
    expect(source).toContain(
      "useRegisterSkyHero(contentRef, { name: locationName, slug })",
    );
    expect(source).toContain("ref={contentRef}");
    // The eyebrow is the first line of the stack after the top row; the
    // block's own padding above it is bare sky, so the block is not the target
    // (on a one-line breadcrumb the block's edge is above the group at rest).
    expect(source.indexOf("ref={contentRef}")).toBeGreaterThan(
      source.indexOf("{breadcrumb}"),
    );
    expect(source).toContain("useRef<HTMLParagraphElement>(null)");
    expect(source).not.toMatch(/<div\s+ref=\{contentRef\}/);
  });

  it("sits before the identity stack", () => {
    expect(source.indexOf("{breadcrumb}")).toBeLessThan(
      source.indexOf("{temperature}"),
    );
  });
});

describe("CurrentConditions — share (the logic lives in ShareControl, in the group)", () => {
  it("holds no share code of its own", () => {
    expect(source).not.toContain("navigator.share");
    expect(source).not.toContain("ShareIcon");
    expect(source).toContain("slug?:");
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
