/**
 * The hero, the Conditions card and the season line use ONLY the Mzizi type
 * scale (owner rule, 2026-10-31): sizes come from the `--text-*` tokens (which
 * alias the Mzizi values) or the Tailwind steps that equal them, weights are
 * 400 / 600 / 700 only, never a literal px/rem size, never weight 200.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf-8");
const css = read("app/globals.css");

/** Mzizi typography.scale: name -> [px, line-height]. */
const SCALE: Record<string, [number, number]> = {
  display: [72, 1.1],
  "display-sm": [60, 1.1],
  h1: [48, 1.15],
  h2: [36, 1.2],
  h3: [30, 1.25],
  h4: [24, 1.3],
  h5: [20, 1.4],
  h6: [16, 1.4],
  "body-lg": [18, 1.6],
  body: [16, 1.6],
  "body-sm": [14, 1.5],
  caption: [12, 1.5],
};

const HERO_FILES = [
  "components/weather/CurrentConditions.tsx",
  "components/weather/HourlyScrollCards.tsx",
  "components/weather/SeasonBadge.tsx",
  "components/layout/MobileMoreMenu.tsx",
];

/** Tailwind size steps that equal a Mzizi scale size. */
const TAILWIND_ON_SCALE = new Set([
  "xs",
  "sm",
  "base",
  "lg",
  "xl",
  "2xl",
  "3xl",
  "4xl",
  "5xl",
  "6xl",
  "7xl",
]);

describe("type-scale tokens alias the Mzizi values", () => {
  for (const [name, [px, leading]] of Object.entries(SCALE)) {
    it(`--text-${name} is ${px}px`, () => {
      const m = css.match(new RegExp(`--text-${name}:\\s*([0-9.]+)rem;`));
      expect(m, `--text-${name} declared`).not.toBeNull();
      expect(parseFloat(m![1]) * 16).toBe(px);
      if (name !== "body") {
        const l = css.match(
          new RegExp(`--text-${name}-leading:\\s*([0-9.]+);`),
        );
        expect(l, `--text-${name}-leading declared`).not.toBeNull();
        expect(parseFloat(l![1])).toBe(leading);
      }
    });
  }
});

describe("hero files use only the scale", () => {
  for (const file of HERO_FILES) {
    const src = read(file);

    it(`${file}: no literal font sizes`, () => {
      expect(src).not.toMatch(/text-\[\d/);
      expect(src).not.toMatch(/text-\[length:\d/);
      expect(src).not.toMatch(/font-size\s*:/);
    });

    it(`${file}: sizes are scale tokens or on-scale Tailwind steps`, () => {
      for (const m of src.matchAll(
        /text-\[length:var\(--text-([a-z-]+)\)\]/g,
      )) {
        expect(SCALE[m[1]], `--text-${m[1]}`).toBeDefined();
      }
      for (const m of src.matchAll(/\btext-(xs|sm|base|lg|xl|[2-9]xl)\b/g)) {
        expect(TAILWIND_ON_SCALE.has(m[1])).toBe(true);
      }
    });

    it(`${file}: weights are only 400, 600 and 700`, () => {
      expect(src).not.toMatch(
        /font-(thin|extralight|light|medium|extrabold|black)\b/,
      );
      expect(src).not.toMatch(/font-\[\d/);
    });

    it(`${file}: no literal letter-spacing in px`, () => {
      expect(src).not.toMatch(/tracking-\[-?\d+px\]/);
    });
  }

  it("the numeral is Display (72px / 1.1) at weight 400 in Noto Sans", () => {
    const src = read("components/weather/CurrentConditions.tsx");
    expect(src).toContain("font-sans text-[length:var(--text-display)]");
    expect(src).toContain("leading-[var(--text-display-leading)] font-normal");
  });

  it("the kestrel rules set no font size or weight of their own", () => {
    const at = css.indexOf("/* ===== Location hero");
    const end = css.indexOf("/* ===== Weather sky palette");
    const block = css.slice(at, end);
    expect(block).not.toMatch(
      /font-size|font-weight|font-medium|font-extralight/,
    );
  });
});
