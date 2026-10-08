import { describe, it, expect } from "vitest";
import { contrastRatio, parseHex, relativeLuminance } from "./contrast";

describe("parseHex", () => {
  it("parses six-digit and three-digit hex", () => {
    expect(parseHex("#0047ab")).toEqual([0, 0x47, 0xab]);
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
  });

  it("rejects non-hex input", () => {
    expect(() => parseHex("rgba(0,0,0,0.5)")).toThrow();
    expect(() => parseHex("#12345")).toThrow();
  });
});

describe("relativeLuminance", () => {
  it("is 0 for black and 1 for white", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 6);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 6);
  });
});

describe("contrastRatio", () => {
  it("matches the WCAG extremes (black on white = 21:1)", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 4);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 4);
  });

  it("is 1:1 for identical colours", () => {
    expect(contrastRatio("#0288d1", "#0288d1")).toBeCloseTo(1, 6);
  });
});
