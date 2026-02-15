import { describe, it, expect } from "vitest";
import {
  heatStressLevel,
  precipTypeName,
  uvConcernLabel,
  moonPhaseName,
} from "./ActivityInsights";

// ── heatStressLevel ──────────────────────────────────────────────────────────

describe("heatStressLevel", () => {
  it("returns 'None' for index below 22", () => {
    expect(heatStressLevel(0).label).toBe("None");
    expect(heatStressLevel(15).label).toBe("None");
    expect(heatStressLevel(21).label).toBe("None");
  });

  it("returns 'Mild' for index 22-23", () => {
    expect(heatStressLevel(22).label).toBe("Mild");
    expect(heatStressLevel(23).label).toBe("Mild");
  });

  it("returns 'Moderate' for index 24-25", () => {
    expect(heatStressLevel(24).label).toBe("Moderate");
    expect(heatStressLevel(25).label).toBe("Moderate");
  });

  it("returns 'Medium' for index 26-27", () => {
    expect(heatStressLevel(26).label).toBe("Medium");
    expect(heatStressLevel(27).label).toBe("Medium");
  });

  it("returns 'Severe' for index 28-29", () => {
    expect(heatStressLevel(28).label).toBe("Severe");
    expect(heatStressLevel(29).label).toBe("Severe");
  });

  it("returns 'Extreme' for index 30+", () => {
    expect(heatStressLevel(30).label).toBe("Extreme");
    expect(heatStressLevel(40).label).toBe("Extreme");
  });

  it("uses brand severity CSS classes, not hardcoded colors", () => {
    const levels = [0, 22, 24, 26, 28, 30];
    for (const index of levels) {
      const { className } = heatStressLevel(index);
      expect(className).toMatch(/^text-severity-/);
    }
  });

  it("escalates severity progressively", () => {
    const severityOrder = ["low", "moderate", "high", "high", "severe", "extreme"];
    const indices = [0, 22, 24, 26, 28, 30];
    for (let i = 0; i < indices.length; i++) {
      expect(heatStressLevel(indices[i]).className).toBe(`text-severity-${severityOrder[i]}`);
    }
  });
});

// ── precipTypeName ───────────────────────────────────────────────────────────

describe("precipTypeName", () => {
  it("returns 'None' for type 0", () => {
    expect(precipTypeName(0)).toBe("None");
  });

  it("returns 'Rain' for type 1", () => {
    expect(precipTypeName(1)).toBe("Rain");
  });

  it("returns 'Snow' for type 2", () => {
    expect(precipTypeName(2)).toBe("Snow");
  });

  it("returns 'Freezing Rain' for type 3", () => {
    expect(precipTypeName(3)).toBe("Freezing Rain");
  });

  it("returns 'Ice Pellets' for type 4", () => {
    expect(precipTypeName(4)).toBe("Ice Pellets");
  });

  it("returns 'Unknown' for unrecognized types", () => {
    expect(precipTypeName(5)).toBe("Unknown");
    expect(precipTypeName(-1)).toBe("Unknown");
    expect(precipTypeName(99)).toBe("Unknown");
  });
});

// ── uvConcernLabel ───────────────────────────────────────────────────────────

describe("uvConcernLabel", () => {
  it("returns 'Low' for concern 0-2", () => {
    expect(uvConcernLabel(0).label).toBe("Low");
    expect(uvConcernLabel(1).label).toBe("Low");
    expect(uvConcernLabel(2).label).toBe("Low");
  });

  it("returns 'Moderate' for concern 3-5", () => {
    expect(uvConcernLabel(3).label).toBe("Moderate");
    expect(uvConcernLabel(4).label).toBe("Moderate");
    expect(uvConcernLabel(5).label).toBe("Moderate");
  });

  it("returns 'High' for concern 6-7", () => {
    expect(uvConcernLabel(6).label).toBe("High");
    expect(uvConcernLabel(7).label).toBe("High");
  });

  it("returns 'Very High' for concern 8-10", () => {
    expect(uvConcernLabel(8).label).toBe("Very High");
    expect(uvConcernLabel(10).label).toBe("Very High");
  });

  it("returns 'Extreme' for concern above 10", () => {
    expect(uvConcernLabel(11).label).toBe("Extreme");
    expect(uvConcernLabel(15).label).toBe("Extreme");
  });

  it("uses brand severity CSS classes, not hardcoded colors", () => {
    const levels = [0, 3, 6, 8, 11];
    for (const concern of levels) {
      const { className } = uvConcernLabel(concern);
      expect(className).toMatch(/^text-severity-/);
    }
  });
});

// ── moonPhaseName ────────────────────────────────────────────────────────────

describe("moonPhaseName", () => {
  it("returns correct phase names for indices 0-7", () => {
    const expected = [
      "New Moon", "Waxing Crescent", "First Quarter", "Waxing Gibbous",
      "Full Moon", "Waning Gibbous", "Third Quarter", "Waning Crescent",
    ];
    for (let i = 0; i < expected.length; i++) {
      expect(moonPhaseName(i)).toBe(expected[i]);
    }
  });

  it("returns 'Unknown' for out-of-range indices", () => {
    expect(moonPhaseName(8)).toBe("Unknown");
    expect(moonPhaseName(-1)).toBe("Unknown");
    expect(moonPhaseName(99)).toBe("Unknown");
  });
});
