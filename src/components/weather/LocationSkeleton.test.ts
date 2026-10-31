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
} from "./LocationSkeleton";

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

describe("LocationSkeleton — calm, no splash", () => {
  it("shows no sentence, wordmark, spinner or dots", () => {
    const visible = html
      .replace(/<span class="sr-only">[^<]*<\/span>/g, "")
      // Hidden sizing text (breadcrumb trail, season line): laid out, never drawn.
      .replace(/<ol class="invisible[^"]*">.*?<\/ol>/g, "")
      .replace(/<span class="invisible[^"]*">[^<]*<\/span>/g, "");
    expect(visible.replace(/<[^>]+>/g, "").trim()).toBe("");
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
      "size-[var(--touch-target-min)]",
    ]) {
      expect(heroSrc).toContain(cls);
    }
  });

  it("the hero has no plate, no button and no outlook rows", () => {
    expect(heroSrc).not.toContain("kori");
    expect(heroSrc).not.toContain("kudu");
    expect(heroSrc).not.toContain("Pick activities");
    expect(heroSrc).not.toContain("leading-relaxed");
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
