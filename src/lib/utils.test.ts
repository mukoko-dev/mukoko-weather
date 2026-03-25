import { describe, it, expect, vi } from "vitest";
import { cn, formatCoords, getScrollBehavior, slugToDisplayName } from "./utils";

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

describe("formatCoords", () => {
  it("formats southern/eastern coordinates correctly", () => {
    expect(formatCoords(-17.83, 31.05)).toBe("17.8300°S, 31.0500°E");
  });

  it("formats northern/western coordinates correctly", () => {
    expect(formatCoords(40.7128, -74.006)).toBe("40.7128°N, 74.0060°W");
  });

  it("formats zero coordinates as north/east", () => {
    expect(formatCoords(0, 0)).toBe("0.0000°N, 0.0000°E");
  });

  it("formats extreme coordinates", () => {
    expect(formatCoords(-90, -180)).toBe("90.0000°S, 180.0000°W");
    expect(formatCoords(90, 180)).toBe("90.0000°N, 180.0000°E");
  });
});

describe("slugToDisplayName", () => {
  it("title-cases simple slugs", () => {
    expect(slugToDisplayName("harare")).toBe("Harare");
  });

  it("uppercases 2-letter country code suffix", () => {
    expect(slugToDisplayName("singapore-sg")).toBe("Singapore SG");
    expect(slugToDisplayName("nairobi-ke")).toBe("Nairobi KE");
  });

  it("strips trailing numeric collision suffixes", () => {
    expect(slugToDisplayName("singapore-sg-14")).toBe("Singapore SG");
    expect(slugToDisplayName("singapore-sg-2")).toBe("Singapore SG");
  });

  it("handles multi-word names with country code", () => {
    expect(slugToDisplayName("orchard-road-sg")).toBe("Orchard Road SG");
    expect(slugToDisplayName("canberra-drive-sg")).toBe("Canberra Drive SG");
  });

  it("handles multi-word names with country code and numeric suffix", () => {
    expect(slugToDisplayName("canberra-drive-sg-3")).toBe("Canberra Drive SG");
  });

  it("does not uppercase segments longer than 2 chars", () => {
    expect(slugToDisplayName("bulawayo")).toBe("Bulawayo");
    expect(slugToDisplayName("new-york-usa")).toBe("New York Usa");
  });

  it("handles empty string", () => {
    expect(slugToDisplayName("")).toBe("");
  });

  it("uppercases bare 2-char slug (country code only)", () => {
    expect(slugToDisplayName("bo")).toBe("BO");
    expect(slugToDisplayName("sg")).toBe("SG");
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
