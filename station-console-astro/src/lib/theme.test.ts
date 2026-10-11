import { describe, expect, it } from "vitest";
import { parseThemePreference, resolveDark } from "./theme";

describe("theme", () => {
  it("parses unknown values as system", () => {
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("light")).toBe("light");
    for (const v of [null, undefined, "", "sepia"])
      expect(parseThemePreference(v)).toBe("system");
  });
  it("resolves dark mode from the preference and the system setting", () => {
    expect(resolveDark("dark", false)).toBe(true);
    expect(resolveDark("light", true)).toBe(false);
    expect(resolveDark("system", true)).toBe(true);
    expect(resolveDark("system", false)).toBe(false);
  });
});
