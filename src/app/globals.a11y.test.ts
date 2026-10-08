/**
 * Accessibility guarantees encoded in globals.css, checked against the real
 * token values (not copies), so a palette edit that breaks WCAG fails here.
 *
 *  - WCAG 1.4.3 (text, 4.5:1) for --color-rain on every surface it sits on
 *  - WCAG 1.4.11 (non-text, 3:1) for focus rings and the on-primary ring
 *  - WCAG 2.4.7 focus rules exist for every button fauna class
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { contrastRatio } from "@/lib/contrast";

const css = readFileSync(resolve(__dirname, "globals.css"), "utf-8");

/** Body of the first `{ ... }` block that follows `marker`. */
function blockAfter(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unclosed block after: ${marker}`);
}

/** Bodies of every top-level rule whose selector matches `sel`, concatenated. */
function blocksMatching(source: string, sel: RegExp): string {
  let out = "";
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (sel.test(m[1].trim())) out += `\n${m[2]}`;
  }
  return out;
}

/**
 * Resolve `--name` to a hex value within a theme scope. Declarations are
 * applied in source order (the last one wins, as in the cascade), and
 * `var(--other)` aliases are followed, so globals.css can alias the Mzizi
 * tokens in mzizi-tokens.css and this test still checks the real colour.
 */
function token(scope: string, name: string, depth = 0): string {
  if (depth > 8) throw new Error(`alias cycle resolving --${name}`);
  const decls = [...scope.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, "g"))];
  if (decls.length === 0) throw new Error(`token --${name} is not declared`);
  const value = decls[decls.length - 1][1].trim();
  const alias = value.match(/^var\((--[\w-]+)\)$/);
  if (alias) return token(scope, alias[1].slice(2), depth + 1);
  if (!/^#[0-9a-fA-F]{3,6}$/.test(value)) {
    throw new Error(`token --${name} is not a hex value: ${value}`);
  }
  return value;
}

const mzizi = readFileSync(resolve(__dirname, "mzizi-tokens.css"), "utf-8");
const LIGHT_GLOBALS = blockAfter(css, ":root {");
const DARK_GLOBALS = blockAfter(css, '[data-theme="dark"] {');
const LIGHT =
  blocksMatching(mzizi, /^:root,\s*\[data-theme="light"\]$/) + LIGHT_GLOBALS;
const DARK =
  blocksMatching(mzizi, /^\.dark,\s*\[data-theme="dark"\]$/) + DARK_GLOBALS;

const THEMES = {
  light: {
    block: LIGHT,
    surfaces: ["surface-base", "surface-card", "surface-elevated"],
  },
  dark: {
    block: DARK,
    surfaces: ["surface-base", "surface-card", "surface-elevated"],
  },
} as const;

describe("--color-rain text contrast (WCAG 1.4.3, 4.5:1)", () => {
  for (const [theme, { block, surfaces }] of Object.entries(THEMES)) {
    it(`meets 4.5:1 on every ${theme}-mode surface the hourly strip uses`, () => {
      const rain = token(block, "color-rain");
      for (const s of surfaces) {
        const bg = token(block, `color-${s}`);
        expect(
          contrastRatio(rain, bg),
          `${theme}: rain ${rain} on ${s} ${bg}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it("replaces the original light #0288d1, which measured 3.66:1 on the page surface", () => {
    expect(contrastRatio("#0288d1", "#faf9f5")).toBeLessThan(4.5);
    expect(token(LIGHT, "color-rain")).not.toBe("#0288d1");
  });
});

describe("focus rings (WCAG 1.4.11 non-text contrast, 3:1)", () => {
  it("primary (storm) focus ring is >= 3:1 on the light page surface", () => {
    expect(
      contrastRatio(
        token(LIGHT, "focus-ring"),
        token(LIGHT, "color-surface-base"),
      ),
    ).toBeGreaterThanOrEqual(3);
  });

  it("primary focus ring is >= 3:1 on the dark page surface", () => {
    expect(
      contrastRatio(
        token(DARK, "focus-ring"),
        token(DARK, "color-surface-base"),
      ),
    ).toBeGreaterThanOrEqual(3);
  });

  it("the on-primary ring used on the .bee header pill is >= 3:1 against the pill in both themes", () => {
    for (const block of [LIGHT, DARK]) {
      expect(
        contrastRatio(
          token(block, "color-primary-foreground"),
          token(block, "color-primary"),
        ),
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("the default primary focus ring would be invisible on the primary pill (why .bee overrides it)", () => {
    expect(
      contrastRatio(token(LIGHT, "focus-ring"), token(LIGHT, "color-primary")),
    ).toBeCloseTo(1, 1);
  });
});

/** Top-level (column-0) rule groups whose selectors include `:focus-visible`. */
function focusVisibleGroups(source: string) {
  const groups: { selectors: string[]; body: string; topLevel: boolean }[] = [];
  const re =
    /^(\.[\w-]+:focus-visible(?:,\s*\.[\w-]+:focus-visible)*)\s*\{([^}]*)\}/gm;
  for (const m of source.matchAll(re)) {
    groups.push({
      selectors: m[1].split(",").map((s) =>
        s
          .trim()
          .replace(/:focus-visible$/, "")
          .replace(/^\./, ""),
      ),
      body: m[2],
      topLevel: true,
    });
  }
  return groups;
}

describe("button fauna focus-visible rings (WCAG 2.4.7)", () => {
  const groups = focusVisibleGroups(css);
  const classes = [
    "kudu",
    "kudu-sm",
    "impala",
    "impala-sm",
    "impala-primary",
    "quail",
  ];

  for (const cls of classes) {
    it(`.${cls} has a :focus-visible ring using the --focus-ring token`, () => {
      const group = groups.find((g) => g.selectors.includes(cls));
      expect(group, `no top-level .${cls}:focus-visible rule`).toBeDefined();
      expect(group!.body).toContain("var(--focus-ring)");
      expect(group!.body).toContain("var(--focus-ring-width");
    });
  }

  it(".bee has a :focus-visible ring in the on-primary foreground colour", () => {
    const group = groups.find((g) => g.selectors.includes("bee"));
    expect(group, "no top-level .bee:focus-visible rule").toBeDefined();
    expect(group!.body).toContain("var(--color-primary-foreground)");
    expect(group!.body).not.toContain("var(--focus-ring)");
  });

  it("keeps the fauna focus rules outside @layer components (unlayered beats the global :focus-visible rule)", () => {
    const layerStart = css.indexOf("@layer components {");
    const layerEnd = css.indexOf("\n}\n", layerStart);
    for (const g of groups) {
      const pos = css.indexOf(`.${g.selectors[0]}:focus-visible`);
      expect(pos > layerEnd || pos < layerStart).toBe(true);
    }
  });

  it("forces a pill radius back on focus (global :focus-visible forces 4px)", () => {
    expect(groups.find((g) => g.selectors.includes("kudu"))!.body).toContain(
      "border-radius: var(--radius-button)",
    );
    expect(groups.find((g) => g.selectors.includes("bee"))!.body).toContain(
      "border-radius: 9999px",
    );
  });

  it("keeps the mouse-user rule that removes rings for non-keyboard focus", () => {
    expect(css).toContain(":focus:not(:focus-visible)");
  });
});
