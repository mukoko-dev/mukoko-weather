import { describe, it, expect } from "vitest";
import {
  _CSS_VAR_FALLBACKS_LIGHT,
  _CSS_VAR_FALLBACKS_DARK,
  normaliseColor,
  resolveColor,
} from "./chart";

describe("CSS variable fallback tables", () => {
  it("light and dark tables have the same keys", () => {
    const lightKeys = Object.keys(_CSS_VAR_FALLBACKS_LIGHT).sort();
    const darkKeys = Object.keys(_CSS_VAR_FALLBACKS_DARK).sort();
    expect(lightKeys).toEqual(darkKeys);
  });

  it("all fallback values are valid hex colors", () => {
    const hexPattern = /^#[0-9A-Fa-f]{3,8}$/;
    for (const [key, value] of Object.entries(_CSS_VAR_FALLBACKS_LIGHT)) {
      expect(value, `Light fallback for ${key}`).toMatch(hexPattern);
    }
    for (const [key, value] of Object.entries(_CSS_VAR_FALLBACKS_DARK)) {
      expect(value, `Dark fallback for ${key}`).toMatch(hexPattern);
    }
  });

  it("all keys start with --", () => {
    for (const key of Object.keys(_CSS_VAR_FALLBACKS_LIGHT)) {
      expect(key).toMatch(/^--/);
    }
  });
});

// Server render (node env: no window) resolves var(--x) through the fallback
// table. The browser resolves the same token via getComputedStyle, which
// returns the lowercase value written in globals.css. Both must agree byte
// for byte, or React hydration warns on SVG attributes like stopColor.
describe("resolved colour casing (server/client parity)", () => {
  it("resolveColor returns lowercase hex for an uppercase fallback", () => {
    expect(resolveColor("var(--color-severity-moderate)")).toBe("#5d4037");
  });

  it("every light fallback resolves to its lowercase form", () => {
    for (const [key, value] of Object.entries(_CSS_VAR_FALLBACKS_LIGHT)) {
      expect(resolveColor(`var(${key})`), key).toBe(value.toLowerCase());
    }
  });

  it("normaliseColor lowercases hex but leaves other colour formats alone", () => {
    expect(normaliseColor("#5D4037")).toBe("#5d4037");
    expect(normaliseColor("#ABC")).toBe("#abc");
    expect(normaliseColor("rgb(10, 20, 30)")).toBe("rgb(10, 20, 30)");
    expect(normaliseColor("RED")).toBe("RED");
  });
});
