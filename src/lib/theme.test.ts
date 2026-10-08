/**
 * Tests for theme.ts — the dependency-free theme resolver shared by the
 * embed widget, the map, and the store (re-exported from store.ts).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveTheme } from "./theme";
import * as storeModule from "./store";

describe("resolveTheme", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes explicit light/dark preferences through", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("follows the OS preference for system", () => {
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: true }),
    });
    expect(resolveTheme("system")).toBe("dark");
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false }),
    });
    expect(resolveTheme("system")).toBe("light");
  });

  it("resolves system to light without a window (SSR)", () => {
    vi.stubGlobal("window", undefined);
    expect(resolveTheme("system")).toBe("light");
  });

  it("is the same function store.ts re-exports", () => {
    expect(storeModule.resolveTheme).toBe(resolveTheme);
  });
});
