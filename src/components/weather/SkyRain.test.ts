import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SkyRain } from "./SkyRain";
import { WeatherSky } from "./WeatherSky";
import { RAIN_TILE_H, RAIN_TILE_W } from "@/lib/sky-rain";

const css = readFileSync("src/app/globals.css", "utf8");

/** The body of the first top-level rule that starts with `selector {`. */
function rule(selector: string): string {
  const at = css.indexOf(`  ${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("\n  }", at));
}

describe("SkyRain", () => {
  const calm = renderToStaticMarkup(createElement(SkyRain, { storm: false }));
  const storm = renderToStaticMarkup(createElement(SkyRain, { storm: true }));

  it("draws one repeating tile of drops from the pattern tile size", () => {
    expect(calm).toContain('class="kestrel-drops"');
    expect(calm).toContain(`width="${RAIN_TILE_W}"`);
    expect(calm).toContain(`height="${RAIN_TILE_H}"`);
    expect(calm).toContain('patternUnits="userSpaceOnUse"');
    expect(calm.match(/<line /g)).toHaveLength(36);
    expect(calm).toMatch(/fill="url\(#kestrel-drops-[A-Za-z0-9_-]+\)"/);
  });

  it("is decorative and carries no inline style or literal colour", () => {
    expect(calm).toContain('aria-hidden="true"');
    expect(calm).toContain('focusable="false"');
    expect(calm).not.toContain("style=");
    expect(calm).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(calm).not.toContain("rgb");
    expect(calm).not.toContain('stroke="');
  });

  it("adds the lightning flash only in a thunderstorm", () => {
    expect(calm).not.toContain("kestrel-flash");
    expect(storm).toContain('class="kestrel-flash"');
  });
});

describe("WeatherSky with moving rain", () => {
  const sky = (family: "rain" | "storm", moveRain: boolean) =>
    renderToStaticMarkup(
      createElement(WeatherSky, { family, texture: "streaks", moveRain }),
    );

  it("swaps the still streaks for the moving layer, never both", () => {
    const still = sky("rain", false);
    expect(still).toContain("kestrel-streaks");
    expect(still).not.toContain("kestrel-drops");
    const moving = sky("rain", true);
    // The rain family's own gradient class (`kestrel-rain`) is untouched.
    expect(moving).toContain("kestrel kestrel-rain");
    expect(moving).toContain("kestrel-drops");
    expect(moving).not.toContain("kestrel-streaks");
    expect(moving).not.toContain("kestrel-flash");
    expect(sky("storm", true)).toContain("kestrel-flash");
  });

  it("is still by default (the loading skeleton never moves)", () => {
    const html = renderToStaticMarkup(
      createElement(WeatherSky, { family: "storm", texture: "streaks" }),
    );
    expect(html).toContain("kestrel-streaks");
    expect(html).not.toContain("kestrel-drops");
  });

  it("does not move the night stars or any family without streaks", () => {
    const stars = renderToStaticMarkup(
      createElement(WeatherSky, {
        family: "clear-night",
        texture: "stars",
        moveRain: true,
      }),
    );
    expect(stars).toContain("kestrel-stars");
    expect(stars).not.toContain("kestrel-drops");
    const none = renderToStaticMarkup(
      createElement(WeatherSky, {
        family: "clear-day",
        texture: null,
        moveRain: true,
      }),
    );
    expect(none).not.toContain("kestrel-drops");
  });
});

describe("the rain family's own gradient class", () => {
  it("stays a palette rule: the moving layer must never share its name (that shrank and masked the whole rain sky)", () => {
    const at = css.indexOf("  .kestrel-rain {\n");
    expect(at).toBeGreaterThan(-1);
    const family = css.slice(at, css.indexOf("\n  }", at));
    expect(family).toContain("--kestrel-top: var(--sky-rain-top)");
    expect(family).not.toMatch(
      /position|height|overflow|mask-image|inset|animation/,
    );
    // And exactly one rule for each name.
    expect(css.match(/^ {2}\.kestrel-rain \{/gm)).toHaveLength(1);
    expect(css.match(/^ {2}\.kestrel-drops \{/gm)).toHaveLength(1);
  });
});

describe("the rain CSS", () => {
  it("keeps the CSS tile height equal to the pattern's", () => {
    expect(rule(".kestrel-drops")).toContain(`--rain-tile: ${RAIN_TILE_H}px`);
  });

  it("uses tokens only: the sky foreground, never a literal colour", () => {
    for (const sel of [
      ".kestrel-drops",
      ".kestrel-drops svg",
      ".kestrel-drops line",
      ".kestrel-flash",
    ]) {
      expect(rule(sel), sel).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    }
    expect(rule(".kestrel-drops line")).toContain("stroke: var(--sky-fg)");
    expect(rule(".kestrel-flash")).toContain("background-color: var(--sky-fg)");
  });

  it("declares every animation only where motion is allowed", () => {
    const at = css.indexOf(
      "  @media (prefers-reduced-motion: no-preference) {\n    .kestrel-drops svg",
    );
    expect(at).toBeGreaterThan(-1);
    const gated = css.slice(at, css.indexOf("\n  }\n", at + 40));
    expect(gated).toContain("animation: kestrel-rain-fall");
    expect(gated).toContain("animation: kestrel-flash");
    // Not anywhere else in the rain rules.
    for (const sel of [
      ".kestrel-drops",
      ".kestrel-drops svg",
      ".kestrel-drops line",
      ".kestrel-flash",
    ]) {
      expect(rule(sel), sel).not.toMatch(/animation\s*:/);
    }
  });

  it("keeps the flash to the same region and fade as the drops", () => {
    const flash = rule(".kestrel-flash");
    const drops = rule(".kestrel-drops");
    for (const line of [
      "inset: 0 0 auto 0",
      "height: min(100%, 40rem)",
      "mask-image: linear-gradient(to bottom, black 65%, transparent)",
    ]) {
      expect(flash).toContain(line);
      expect(drops).toContain(line);
    }
  });

  it("loops seamlessly: the layer moves by exactly one tile", () => {
    const at = css.indexOf("@keyframes kestrel-rain-fall");
    const frames = css.slice(at, css.indexOf("@keyframes kestrel-flash"));
    expect(frames).toContain("translateY(0)");
    // The same function at both ends, so no engine has to pair mixed ones.
    expect(frames).toContain("translateY(var(--rain-tile))");
    expect(frames).not.toContain("translate3d");
    // The svg starts one tile above the box and is one tile taller.
    expect(rule(".kestrel-drops svg")).toContain(
      "top: calc(-1 * var(--rain-tile))",
    );
    expect(rule(".kestrel-drops svg")).toContain(
      "height: calc(100% + var(--rain-tile))",
    );
  });

  it("keeps the lightning gentle: low contrast, a double flicker, seconds apart (WCAG 2.3.1)", () => {
    const at = css.indexOf("@keyframes kestrel-flash");
    const frames = css.slice(at, css.indexOf("\n  }\n  /*", at) + 10);
    const peaks = [...frames.matchAll(/opacity:\s*([0-9.]+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(Math.max(...peaks)).toBeLessThanOrEqual(0.14);
    // Two flashes (two local peaks) and quiet for the rest of the cycle.
    const flashes = peaks.filter(
      (p, i) => p > 0.05 && (peaks[i - 1] ?? 0) < p && (peaks[i + 1] ?? 0) < p,
    );
    expect(flashes).toHaveLength(2);
    const duration = css.match(/animation: kestrel-flash ([0-9.]+)s/);
    expect(Number(duration?.[1])).toBeGreaterThanOrEqual(6);
  });
});
