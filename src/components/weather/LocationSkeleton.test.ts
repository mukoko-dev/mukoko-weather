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
import { HeroSkeleton } from "./HeroSkeleton";
import { Shimmer } from "@/components/ui/shimmer";

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

  it("reserves the breadcrumb row and does not redraw the header or nav", () => {
    expect(html).toContain("pt-3");
    expect(skeletonSrc).not.toContain("<Header");
    expect(skeletonSrc).not.toContain("MobileNav");
    expect(skeletonSrc).not.toContain("<footer");
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
      .replace(/<span class="invisible">[^<]*<\/span>/g, "");
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

  it("hero bars carry the real text classes so the box matches", () => {
    for (const cls of [
      "text-2xl",
      "text-8xl",
      "sm:text-9xl",
      "text-xl",
      "text-lg",
      "min-h-[var(--touch-target-min)]",
    ]) {
      expect(heroSrc).toContain(cls);
    }
  });
});

describe("Shimmer and .okapi", () => {
  it("renders a decorative bar", () => {
    const bar = renderToStaticMarkup(
      createElement(Shimmer, { className: "w-4" }),
    );
    expect(bar).toContain('class="okapi w-4"');
    expect(bar).toContain('aria-hidden="true"');
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
