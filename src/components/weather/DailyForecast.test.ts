import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempPercent, tempTrackGradient } from "./DailyForecast";
import { TEMP_SCALE } from "@/lib/weather-scales";

describe("tempPercent", () => {
  it("returns 0 for the minimum temperature", () => {
    expect(tempPercent(10, 10, 30)).toBe(0);
  });

  it("returns 100 for the maximum temperature", () => {
    expect(tempPercent(30, 10, 30)).toBe(100);
  });

  it("returns 50 for the midpoint", () => {
    expect(tempPercent(20, 10, 30)).toBe(50);
  });

  it("returns 50 when range is zero (same min and max)", () => {
    expect(tempPercent(20, 20, 20)).toBe(50);
  });

  it("handles negative temperatures", () => {
    expect(tempPercent(-5, -10, 0)).toBe(50);
    expect(tempPercent(-10, -10, 0)).toBe(0);
    expect(tempPercent(0, -10, 0)).toBe(100);
  });

  it("calculates correct percentage for arbitrary values", () => {
    // 25% through range 0-40 is 10
    expect(tempPercent(10, 0, 40)).toBe(25);
    // 75% through range 0-40 is 30
    expect(tempPercent(30, 0, 40)).toBe(75);
  });
});

describe("tempTrackGradient", () => {
  it("is one linear-gradient through the temperature scale tokens, cold to hot", () => {
    const result = tempTrackGradient(10, 30);
    expect(result).toMatch(/^linear-gradient\(to right, /);
    const tokens = [...result.matchAll(/var\((--wx-temp-\d)\)/g)].map(
      (m) => m[1],
    );
    expect(tokens).toEqual(TEMP_SCALE.bands.map((b) => b.token));
    expect(result.match(/linear-gradient\(/g)).toHaveLength(1);
  });

  it("puts each colour at the middle of its band, mapped onto the week's track", () => {
    // Track 10 to 30 Cel: 20 Cel (middle of Warm 16-24) is half way.
    const result = tempTrackGradient(10, 30);
    expect(result).toContain("var(--wx-temp-5) 50%");
    // 12 Cel (middle of Mild 8-16) is 10% along; 4 Cel (Cool 0-8) is -30%.
    expect(result).toContain("var(--wx-temp-4) 10%");
    expect(result).toContain("var(--wx-temp-3) -30%");
  });

  it("gives a temperature the same colour on every row (one track-wide gradient)", () => {
    // The same call twice is the same string: rows share it, each pill only
    // windows onto it.
    expect(tempTrackGradient(12, 29)).toBe(tempTrackGradient(12, 29));
  });

  it("has no hard seam: stop positions strictly ascend", () => {
    for (const [min, max] of [
      [10, 30],
      [-5, 4],
      [20, 20],
    ]) {
      const pcts = [
        ...tempTrackGradient(min, max).matchAll(/\) (-?[\d.]+)%/g),
      ].map((m) => Number(m[1]));
      pcts.forEach((p, i) => {
        if (i > 0) expect(p, `${min}..${max}`).toBeGreaterThan(pcts[i - 1]);
      });
    }
  });

  it("copes with a flat week (no range) without dividing by zero", () => {
    expect(tempTrackGradient(20, 20)).not.toMatch(/NaN|Infinity/);
  });

  it("does not contain hardcoded hex colors", () => {
    expect(tempTrackGradient(0, 40)).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(/);
  });
});

describe("DailyForecast source", () => {
  const src = readFileSync(join(__dirname, "DailyForecast.tsx"), "utf8");

  it("draws each day's pill as a window onto the week's gradient", () => {
    expect(src).toContain("trackWindow(");
    expect(src).toContain("backgroundImage: trackGradient");
    // The old per-pill gradient (stops in the wrong coordinate space) is gone.
    expect(src).not.toContain("tempBarGradient");
    expect(src).not.toContain("--color-temp-");
  });

  it("outlines the pill so pale temperature colours hold 3:1 on the card", () => {
    expect(src).toContain("ring-wx-outline");
  });

  it("shows no UV line for a day the provider has no UV maximum for", () => {
    // The MET Norway failover has none past its hourly steps (null, not 0).
    expect(src).toContain("{uvMax != null && (");
  });
});
