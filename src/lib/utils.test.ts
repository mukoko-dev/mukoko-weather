import { describe, it, expect, vi } from "vitest";
import { cn, getScrollBehavior } from "./utils";

describe("cn", () => {
  it("merges multiple class strings", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("resolves Tailwind class conflicts (last wins)", () => {
    expect(cn("p-4", "p-2")).toBe("p-2");
  });

  it("resolves Tailwind color conflicts", () => {
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("filters out falsy values", () => {
    expect(cn("a", false, "b", undefined, null, "c")).toBe("a b c");
  });

  it("handles empty input", () => {
    expect(cn()).toBe("");
  });

  it("handles conditional class objects", () => {
    const result = cn("base", { active: true, disabled: false });
    expect(result).toContain("base");
    expect(result).toContain("active");
    expect(result).not.toContain("disabled");
  });

  it("handles arrays of classes", () => {
    expect(cn(["a", "b"], "c")).toBe("a b c");
  });
});

describe("getScrollBehavior", () => {
  it("returns 'instant' when prefers-reduced-motion matches", () => {
    vi.stubGlobal("window", {
      matchMedia: (q: string) => ({ matches: q.includes("prefers-reduced-motion") }),
    });
    expect(getScrollBehavior()).toBe("instant");
    vi.unstubAllGlobals();
  });

  it("returns 'smooth' when prefers-reduced-motion does not match", () => {
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false }),
    });
    expect(getScrollBehavior()).toBe("smooth");
    vi.unstubAllGlobals();
  });
});
