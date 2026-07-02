import { describe, it, expect } from "vitest";
import { nowcastSummary } from "./MinutelyNowcast";
import type { MinutelyData } from "@/lib/weather";

function minutely(precip: number[]): MinutelyData {
  return { time: precip.map((_, i) => `+${i * 15}`), precipitation: precip };
}

describe("nowcastSummary", () => {
  it("reports no rain when all steps are dry", () => {
    expect(nowcastSummary(minutely([0, 0, 0, 0]))).toBe(
      "No rain expected in the next hour.",
    );
  });

  it("reports rain starting soon when a later step is wet", () => {
    expect(nowcastSummary(minutely([0, 0, 0.5, 0.2]))).toBe("Rain starting in ~30 min.");
  });

  it("reports rain now when the first step is wet but easing", () => {
    expect(nowcastSummary(minutely([0.4, 0.1, 0, 0]))).toBe(
      "Rain is falling now — easing within the hour.",
    );
  });

  it("reports continuous rain when every step is wet", () => {
    expect(nowcastSummary(minutely([0.4, 0.5, 0.3, 0.2]))).toBe(
      "Rain is falling and continues through the next hour.",
    );
  });

  it("handles empty precipitation gracefully", () => {
    expect(nowcastSummary(minutely([]))).toBe("No nowcast data available.");
  });

  it("treats precip below threshold as dry", () => {
    // 0.05mm < 0.1mm threshold → still 'no rain'
    expect(nowcastSummary(minutely([0.05, 0.05, 0.05, 0.05]))).toBe(
      "No rain expected in the next hour.",
    );
  });
});