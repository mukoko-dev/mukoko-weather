import { describe, it, expect } from "vitest";
import {
  HAZE_LEVEL_ORDER,
  HAZE_LEVEL_LABELS,
  HAZE_TYPE_LABELS,
  HAZE_TYPE_ICON,
  hazeLevelRank,
  hazeSeverityClasses,
  isHazeWorthShowing,
  formatMonthSpan,
  formatPeakTime,
  formatVisibility,
  formatMicrograms,
  formatOfficialLine,
  type HazeSeason,
} from "./haze";

const activeSeason: HazeSeason = {
  name: "Southeast Asian haze season",
  active: true,
  typicalMonths: [6, 7, 8, 9, 10],
  typicalType: "smoke",
};
const inactiveSeason: HazeSeason = { ...activeSeason, active: false };

describe("hazeLevelRank / HAZE_LEVEL_ORDER", () => {
  it("orders levels least to most severe", () => {
    expect(HAZE_LEVEL_ORDER).toEqual([
      "none",
      "light",
      "moderate",
      "heavy",
      "hazardous",
    ]);
    expect(hazeLevelRank("none")).toBe(0);
    expect(hazeLevelRank("hazardous")).toBe(4);
  });

  it("has a label for every level", () => {
    for (const level of HAZE_LEVEL_ORDER) {
      expect(HAZE_LEVEL_LABELS[level].length).toBeGreaterThan(0);
    }
  });
});

describe("hazeSeverityClasses", () => {
  it("uses severity tokens only", () => {
    for (const level of HAZE_LEVEL_ORDER) {
      const c = hazeSeverityClasses(level);
      for (const cls of [c.text, c.fill, c.soft]) {
        expect(cls).toMatch(/(text|bg)-severity-/);
        expect(cls).not.toMatch(/#|rgb|green|red|amber|orange/);
      }
    }
  });

  it("maps higher levels to more severe tokens", () => {
    expect(hazeSeverityClasses("light").fill).toBe("bg-severity-moderate");
    expect(hazeSeverityClasses("heavy").fill).toBe("bg-severity-severe");
    expect(hazeSeverityClasses("hazardous").fill).toBe("bg-severity-extreme");
  });
});

describe("type labels and icon keys", () => {
  it("labels and icon keys exist for every type", () => {
    for (const type of ["clear", "smoke", "dust", "smog", "mist"] as const) {
      expect(HAZE_TYPE_LABELS[type]).toBeTruthy();
      expect(HAZE_TYPE_ICON[type]).toBeTruthy();
    }
  });
});

describe("isHazeWorthShowing", () => {
  it("shows for haze at light or above", () => {
    expect(isHazeWorthShowing("light", "smoke", null)).toBe(true);
    expect(isHazeWorthShowing("heavy", "dust", null)).toBe(true);
    expect(isHazeWorthShowing("hazardous", "smog", inactiveSeason)).toBe(true);
  });

  it("hides when there is no haze", () => {
    expect(isHazeWorthShowing("none", "clear", null)).toBe(false);
    expect(isHazeWorthShowing("none", "clear", activeSeason)).toBe(false);
    expect(isHazeWorthShowing(null, null, activeSeason)).toBe(false);
    expect(isHazeWorthShowing(undefined, undefined, undefined)).toBe(false);
  });

  it("hides mist even at elevated levels without an active season", () => {
    expect(isHazeWorthShowing("light", "mist", null)).toBe(false);
    expect(isHazeWorthShowing("light", "mist", inactiveSeason)).toBe(false);
  });

  it("shows mist with elevated readings during an active haze season", () => {
    expect(isHazeWorthShowing("light", "mist", activeSeason)).toBe(true);
  });

  it("hides a haze season that is out of season", () => {
    expect(isHazeWorthShowing("none", "clear", inactiveSeason)).toBe(false);
  });
});

describe("formatMonthSpan", () => {
  it("formats a normal range", () => {
    expect(formatMonthSpan([6, 7, 8, 9, 10])).toBe("Jun–Oct");
  });

  it("formats a wrap-around range in window order", () => {
    expect(formatMonthSpan([11, 12, 1, 2, 3])).toBe("Nov–Mar");
  });

  it("formats a single month", () => {
    expect(formatMonthSpan([7])).toBe("Jul");
  });

  it("returns empty for empty or invalid input", () => {
    expect(formatMonthSpan([])).toBe("");
    expect(formatMonthSpan([0, 13])).toBe("");
  });
});

describe("formatPeakTime", () => {
  it("extracts HH:MM from a local ISO timestamp", () => {
    expect(formatPeakTime("2026-10-09T07:00")).toBe("07:00");
  });

  it("returns null for missing or unparseable input", () => {
    expect(formatPeakTime(null)).toBeNull();
    expect(formatPeakTime(undefined)).toBeNull();
    expect(formatPeakTime("tomorrow")).toBeNull();
  });
});

describe("value formatters", () => {
  it("formats visibility in km", () => {
    expect(formatVisibility(11.4)).toBe("11.4 km");
    expect(formatVisibility(null)).toBe("—");
  });

  it("formats concentrations in µg/m³ rounded", () => {
    expect(formatMicrograms(89.4)).toBe("89 µg/m³");
    expect(formatMicrograms(undefined)).toBe("—");
  });

  it("formats the official PSI line", () => {
    expect(
      formatOfficialLine({
        source: "NEA Singapore",
        metric: "PSI",
        value: 142,
        band: "Unhealthy",
        region: "West",
      }),
    ).toBe("NEA Singapore PSI 142 · Unhealthy · West");
  });
});
