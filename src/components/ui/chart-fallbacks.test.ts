import { describe, it, expect } from "vitest";
import { _CSS_VAR_FALLBACKS_LIGHT, _CSS_VAR_FALLBACKS_DARK } from "./chart";

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
