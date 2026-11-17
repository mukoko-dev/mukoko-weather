/**
 * LocationSkeleton: the structural loading state. Rendered for real
 * (react-dom/server) plus source checks for what a render cannot show.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  HOURLY_PLACEHOLDER_COUNT,
  LocationSkeleton,
  TILE_PLACEHOLDER_COUNT,
  TYPICAL_SEASON_NOTE,
} from "./LocationSkeleton";
import { TYPICAL_OUTLOOK } from "./HeroSkeleton";

const read = (p: string) => readFileSync(resolve(__dirname, p), "utf-8");
const skeletonSrc = read("LocationSkeleton.tsx");
const heroSrc = read("HeroSkeleton.tsx");
const shimmerSrc = read("../ui/shimmer.tsx");
const css = read("../../app/globals.css");
const html = renderToStaticMarkup(createElement(LocationSkeleton));

describe("LocationSkeleton — structure", () => {
  it("renders the hero, the hourly strip and the tile grid", () => {
    expect(html).toContain('data-skeleton="hero"');
    expect(html.match(/min-w-\[60px\]/g)).toHaveLength(
      HOURLY_PLACEHOLDER_COUNT,
    );
    expect(html.match(/data-skeleton="tile"/g)).toHaveLength(
      TILE_PLACEHOLDER_COUNT,
    );
  });

  it("uses the real page frame, columns and bottom clearance", () => {
    expect(html).toContain("max-w-7xl");
    expect(html).toContain("pt-[var(--space-section)]");
    expect(html).toContain("pb-[var(--mobile-nav-clearance)]");
    expect(html).toContain("lg:grid-cols-3");
    expect(html).toContain("herd");
  });

  it("does not redraw the header or the nav; the hero holds its own top row", () => {
    expect(skeletonSrc).not.toContain("<Header");
    expect(skeletonSrc).not.toContain("MobileNav");
    expect(skeletonSrc).not.toContain("<footer");
    expect(skeletonSrc).not.toContain("<nav");
  });

  it("hides the phone header exactly as the real hero does (data-sky-hero)", () => {
    expect(html).toContain("data-sky-hero");
    expect(heroSrc).toContain("data-sky-hero");
  });

  it("draws the Conditions card on the sky card surface, under the hero", () => {
    expect(html).toContain("kestrel-card");
    expect(html.indexOf('data-skeleton="hero"')).toBeLessThan(
      html.indexOf('data-skeleton="conditions"'),
    );
  });

  it("paints the page sky through the shared .kestrel gradient", () => {
    expect(html).toContain("kestrel kestrel-");
    expect(skeletonSrc).toContain("<WeatherSky");
  });

  it("keeps the hero in its own swappable component", () => {
    expect(skeletonSrc).toContain("<HeroSkeleton />");
    expect(heroSrc).toContain("export function HeroSkeleton");
  });
});

describe("LocationSkeleton — sized by typical copy", () => {
  it("lays a typical outlook sentence out invisibly in the hero, with the hero's own paragraph type", () => {
    expect(TYPICAL_OUTLOOK.length).toBeGreaterThanOrEqual(40);
    expect(TYPICAL_OUTLOOK.length).toBeLessThanOrEqual(110);
    expect(html).toContain(`<span class="invisible">${TYPICAL_OUTLOOK}</span>`);
    // Same text size, leading and measure as the hero's outlook line.
    expect(html).toContain(
      '<p class="relative mt-3 max-w-[40ch] text-pretty text-[length:var(--text-body)] leading-[var(--text-body-leading)]">',
    );
    expect(heroSrc).toContain(
      "mt-3 max-w-[40ch] text-pretty text-[length:var(--text-body)] leading-[var(--text-body-leading)]",
    );
  });

  it("the Conditions card skeleton has no outlook line: the hero owns the outlook", () => {
    const conditions = html.slice(html.indexOf('data-skeleton="conditions"'));
    expect(conditions).not.toContain(TYPICAL_OUTLOOK);
    expect(skeletonSrc).not.toContain("TYPICAL_OUTLOOK");
  });

  it("draws one bar per wrapped line: the mask period is the line height", () => {
    // --text-body-leading is 1.6, so the repeating mask runs in 1.6em steps.
    expect(heroSrc).toContain("transparent_1.6em");
    expect(heroSrc).toContain("[mask-image:repeating-linear-gradient(");
    expect(heroSrc).toContain("[-webkit-mask-image:repeating-linear-gradient(");
  });

  it("sizes the season line with a note of typical length (19 to 51 chars)", () => {
    expect(TYPICAL_SEASON_NOTE.length).toBeGreaterThanOrEqual(19);
    expect(TYPICAL_SEASON_NOTE.length).toBeLessThanOrEqual(51);
    expect(html).toContain(TYPICAL_SEASON_NOTE);
  });
});

describe("LocationSkeleton — calm, no splash", () => {
  it("shows no sentence, wordmark, spinner or dots", () => {
    const visible = html
      .replace(/<span class="sr-only">[^<]*<\/span>/g, "")
      // Hidden sizing text (breadcrumb trail, season line): laid out, never drawn.
      .replace(/<ol class="invisible[^"]*">.*?<\/ol>/g, "")
      .replace(/<span class="invisible[^"]*">[^<]*<\/span>/g, "");
    // Text content: each chunk after a "<" loses everything up to its closing ">".
    const text = visible
      .split("<")
      .map((chunk, i) =>
        i === 0 ? chunk : chunk.slice(chunk.indexOf(">") + 1),
      )
      .join("");
    expect(text.trim()).toBe("");
    expect(skeletonSrc).not.toContain("MukokoLogo");
    expect(skeletonSrc).not.toContain("Spinner");
    expect(skeletonSrc).not.toContain("animate-pulse");
  });

  it("draws no solid mineral plate (the hero is bars on the page sky)", () => {
    expect(html).not.toContain("kori");
    expect(heroSrc).not.toContain("kori");
    expect(heroSrc).not.toContain("bg-mineral");
  });

  it("opens no WebGL context", () => {
    expect(skeletonSrc).not.toContain("createWeatherScene");
    expect(skeletonSrc).not.toMatch(/from "three"/);
  });

  it("paints the shared static sky", () => {
    expect(skeletonSrc).toContain("<WeatherSky");
  });
});

describe("LocationSkeleton — accessibility", () => {
  it("is one polite busy status region, blocks are aria-hidden", () => {
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading"');
    expect(html).toContain("Loading weather");
    for (const section of html.match(/<section[^>]*>/g) ?? []) {
      expect(section).toContain('aria-hidden="true"');
    }
  });

  it("has nothing interactive", () => {
    expect(html).not.toMatch(/<(a|button|input)\b/);
  });
});

describe("LocationSkeleton — the hero's top row matches the loaded hero", () => {
  it("draws no group of its own: the Quick actions group is the layout's, already on screen and live while the place loads", () => {
    // (The breadcrumb keeps the group's reserve token, --hadeda-reserve.)
    expect(html).not.toMatch(/class="[^"]*(?<![-\w])hadeda(?![-\w])/);
    expect(html).not.toContain("data-quick-actions");
    expect(heroSrc).not.toMatch(/className="[^"]*(?<![-\w])hadeda(?![-\w])/);
    // No round placeholder stands in for Share or the group's controls.
    expect(html).not.toMatch(
      /class="[^"]*size-\[var\(--touch-target-min\)\][^"]*rounded-full/,
    );
  });

  it("registers itself as the sky hero (without a place), so the group is already clear over it and keeps its look when the hero arrives", () => {
    expect(heroSrc).toContain('"use client"');
    expect(heroSrc).toContain("useRegisterSkyHero(contentRef, null)");
    expect(heroSrc).toContain("ref={contentRef}");
    expect(heroSrc).toContain("useRef<HTMLParagraphElement>(null)");
    expect(heroSrc).toContain("data-sky-hero");
  });

  it("leaves the breadcrumb the same room for the group, and the row the same 48px", () => {
    expect(heroSrc).toContain("min-h-[var(--touch-target-min)]");
    expect(heroSrc).toContain("pr-[var(--hadeda-reserve)]");
    expect(heroSrc).toContain("sm:pr-0");
  });
});

describe("LocationSkeleton — the hero's data card is the live card's box", () => {
  const cardSrc = read("hero-card-classes.ts");
  const liveSrc = read("HeroDataCard.tsx");
  const curveSrc = read("HeroDayCurve.tsx");

  it("draws the card under the sky, in the same surface, strip, curve, readings and row classes the live card reads", () => {
    expect(html.indexOf('data-skeleton="hero"')).toBeLessThan(
      html.indexOf('data-skeleton="hero-card"'),
    );
    for (const name of [
      "HERO_CARD_CLASS",
      "HERO_STRIP_CLASS",
      "HERO_STRIP_CELL_CLASS",
      "HERO_CURVE_CLASS",
      "HERO_READINGS_CLASS",
      "HERO_READING_CLASS",
      "HERO_ROW_CLASS",
      "HERO_CAPTION",
      "HERO_FIGURE",
    ]) {
      expect(cardSrc, name).toContain(`export const ${name}`);
      expect(heroSrc, name).toContain(name);
    }
    // The live card reads the very same strings (one source, so no drift).
    for (const name of [
      "HERO_CARD_CLASS",
      "HERO_STRIP_CLASS",
      "HERO_READINGS_CLASS",
      "HERO_READING_CLASS",
      "HERO_ROW_CLASS",
    ]) {
      expect(liveSrc, name).toContain(name);
    }
    expect(curveSrc).toContain("HERO_CURVE_CLASS");
  });

  it("holds as many hour cells as the live strip, three readings, the curve's height and a 49px last row", () => {
    expect(html.match(/<li class="min-w-0 text-center">/g)).toHaveLength(5);
    expect(heroSrc).toContain("HERO_STRIP_HOURS");
    expect(heroSrc).toContain("[0, 1, 2].map");
    expect(heroSrc).toContain("HERO_CURVE_HEIGHT_CLASS");
    expect(cardSrc).toContain("min-h-[var(--touch-target-min)]");
    expect(cardSrc).toContain("h-[7.25rem]");
  });

  it("the skeleton's sky rows are the live sky's rows (identity grid, glyph column, outlook)", () => {
    const live = read("CurrentConditions.tsx");
    for (const cls of [
      "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 min-[360px]:gap-x-3",
      "col-start-1 row-start-1",
      "col-start-1 row-start-2",
      "col-start-1 row-start-3",
      "col-start-2 row-span-3 row-start-1 self-center block size-10 min-[360px]:size-14",
      "pt-4 pb-[26px]",
      "mt-3 max-w-[40ch] text-pretty text-[length:var(--text-body)] leading-[var(--text-body-leading)]",
    ]) {
      expect(heroSrc, cls).toContain(cls);
      expect(live, cls).toContain(cls);
    }
  });
});

describe("LocationSkeleton — tokens only", () => {
  it("has no hex, rgba, inline style or shadow", () => {
    for (const src of [skeletonSrc, heroSrc, shimmerSrc]) {
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src).not.toContain("rgba(");
      expect(src).not.toContain("style={{");
      expect(src).not.toContain("shadow");
    }
  });

  it("hero rows carry the real type-scale tokens so the box matches", () => {
    for (const cls of [
      "--text-caption",
      "--text-h2",
      "--text-display",
      "--text-h5",
      "--text-body-lg",
      "pt-4 pb-[26px]",
      "min-h-[var(--touch-target-min)]",
    ]) {
      expect(heroSrc).toContain(cls);
    }
  });

  it("the hero has no plate and no button: the sky is bars, the card is one surface", () => {
    expect(heroSrc).not.toContain("kori");
    expect(heroSrc).not.toContain("kudu");
    expect(heroSrc).not.toContain("Pick activities");
    expect(heroSrc).not.toContain("leading-relaxed");
    expect(html).not.toContain("<button");
  });

  it("only animates when motion is welcome; static otherwise", () => {
    const block = css.match(
      /@media \(prefers-reduced-motion: no-preference\) \{\s*\.okapi \{[\s\S]*?\n\}\n/,
    );
    expect(block?.[0]).toContain("animation: okapi-shimmer");
    // The class itself carries no animation: the base rule is static.
    const base = css.match(/\.okapi \{\s*@apply[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(base).not.toContain("animation");
    expect(base).toContain("background-color: var(--okapi-base)");
  });

  it("uses theme-neutral currentColor tints, no literals", () => {
    expect(css).toContain("color-mix(in srgb, currentColor 14%, transparent)");
  });
});
