import { describe, it, expect } from "vitest";
import { tempPercent, tempBarGradient } from "./DailyForecast";

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

describe("tempBarGradient", () => {
  it("returns a linear-gradient using CSS custom properties", () => {
    const result = tempBarGradient(20, 80);
    expect(result).toContain("linear-gradient");
    expect(result).toContain("var(--color-temp-cool)");
    expect(result).toContain("var(--color-temp-mild)");
    expect(result).toContain("var(--color-temp-warm)");
  });

  it("uses the low percentage for the cool stop", () => {
    const result = tempBarGradient(25, 75);
    expect(result).toContain("var(--color-temp-cool) 25%");
  });

  it("uses the high percentage for the warm stop", () => {
    const result = tempBarGradient(25, 75);
    expect(result).toContain("var(--color-temp-warm) 75%");
  });

  it("calculates the midpoint for the mild stop", () => {
    const result = tempBarGradient(20, 80);
    // midpoint = (20 + 80) / 2 = 50
    expect(result).toContain("var(--color-temp-mild) 50%");
  });

  it("does not contain hardcoded hex colors", () => {
    const result = tempBarGradient(0, 100);
    expect(result).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});
