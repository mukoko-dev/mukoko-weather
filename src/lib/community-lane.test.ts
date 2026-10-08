import { describe, it, expect } from "vitest";
import type { HourlyWeather } from "./weather";
import type { SuitabilityRuleDoc } from "./db";
import {
  LANE_HOURS,
  LANE_PAST_HOURS,
  assignPinTiers,
  bestWindow,
  buildLaneCells,
  formatLaneHour,
  groupReportsByHour,
  laneBaseMs,
  laneRuns,
  laneSummary,
  type LaneCell,
} from "./community-lane";

const HOUR = 3_600_000;
// Fixed clock: 10:30 local. The current hour starts at 10:00.
const NOW = new Date(2026, 9, 8, 10, 30, 0);
const BASE = laneBaseMs(NOW);

/** Hourly forecast covering the full lane window, with a per-hour weather code. */
function hourlyWithCodes(codes: (hourOffset: number) => number): HourlyWeather {
  const n = LANE_HOURS + 4;
  const time: string[] = [];
  const weather_code: number[] = [];
  const arr = (fill: number) => Array.from({ length: n }, () => fill);
  for (let i = 0; i < n; i++) {
    time.push(new Date(BASE + i * HOUR).toISOString());
    weather_code.push(codes(i));
  }
  return {
    time,
    weather_code,
    temperature_2m: arr(24),
    apparent_temperature: arr(24),
    relative_humidity_2m: arr(50),
    precipitation_probability: arr(0),
    precipitation: arr(0),
    visibility: arr(20000),
    cloud_cover: arr(20),
    surface_pressure: arr(1010),
    wind_speed_10m: arr(5),
    wind_direction_10m: arr(90),
    wind_gusts_10m: arr(8),
    uv_index: arr(3),
    is_day: arr(1),
  };
}

// Farming rule: heavy precip (WMO code >= 65 maps to precipitationType 1)
// is poor when the code is >= 80, fallback good. Mirrors the shape of the
// seeded rules without depending on them.
const rules = new Map<string, SuitabilityRuleDoc>([
  [
    "category:farming",
    {
      key: "category:farming",
      conditions: [
        {
          field: "precipitationType",
          operator: "gte",
          value: 2,
          level: "poor",
          label: "Poor",
          colorClass: "",
          bgClass: "",
          detail: "Freezing precipitation",
        },
      ],
      fallback: {
        level: "good",
        label: "Good",
        colorClass: "",
        bgClass: "",
        detail: "Workable",
      },
      updatedAt: new Date(0),
    } as SuitabilityRuleDoc,
  ],
]);
const farming = { id: "crop-farming", category: "farming" as const };

describe("laneBaseMs / formatLaneHour", () => {
  it("starts the lane 12 whole hours before the current hour", () => {
    expect(BASE).toBe(new Date(2026, 9, 7, 22, 0, 0).getTime());
  });

  it("formats local HH:00", () => {
    expect(formatLaneHour(new Date(2026, 9, 8, 6, 0).getTime())).toBe("06:00");
    expect(formatLaneHour(new Date(2026, 9, 8, 15, 45).getTime())).toBe(
      "15:00",
    );
  });
});

describe("buildLaneCells", () => {
  it("returns 24 cells, with the current hour at index 12", () => {
    const cells = buildLaneCells(
      farming,
      hourlyWithCodes(() => 0),
      rules,
      NOW,
    );
    expect(cells).toHaveLength(LANE_HOURS);
    expect(cells[LANE_PAST_HOURS].at).toBe(new Date(2026, 9, 8, 10).getTime());
    expect(cells[LANE_PAST_HOURS - 1].isPast).toBe(true);
    expect(cells[LANE_PAST_HOURS].isPast).toBe(false);
  });

  it("scores each hour with the activity's rule", () => {
    const cells = buildLaneCells(
      farming,
      hourlyWithCodes((i) => (i >= 14 && i <= 15 ? 67 : 0)),
      rules,
      NOW,
    );
    // Index 12 is the current hour; 14 and 15 are two and three hours ahead.
    expect(cells[14].level).toBe("poor");
    expect(cells[15].level).toBe("poor");
    expect(cells[16].level).toBe("good");
  });

  it("leaves hours with no forecast or no rule as null", () => {
    const hourly = hourlyWithCodes(() => 0);
    const noRule = buildLaneCells(
      { id: "tennis", category: "sports" },
      hourly,
      rules,
      NOW,
    );
    expect(noRule.every((c) => c.level === null)).toBe(true);

    const noData = buildLaneCells(farming, undefined, rules, NOW);
    expect(noData.every((c) => c.level === null)).toBe(true);
  });
});

function cellsFrom(levels: (LaneCell["level"] | null)[]): LaneCell[] {
  return levels.map((level, index) => ({
    index,
    at: BASE + index * HOUR,
    level,
    isPast: index < LANE_PAST_HOURS,
  }));
}

describe("laneRuns", () => {
  it("merges consecutive equal ratings and skips no-data cells", () => {
    const cells = cellsFrom([
      "good",
      "good",
      "poor",
      null,
      "good",
      ...Array<LaneCell["level"]>(19).fill("good"),
    ]);
    expect(laneRuns(cells)).toEqual([
      { level: "good", start: 0, end: 2 },
      { level: "poor", start: 2, end: 3 },
      { level: "good", start: 4, end: 24 },
    ]);
  });
});

describe("bestWindow", () => {
  it("picks the longest good-or-better run from the current hour onwards", () => {
    const levels: LaneCell["level"][] =
      Array<LaneCell["level"]>(24).fill("poor");
    // A long run in the past must not win.
    for (let i = 0; i < 8; i++) levels[i] = "excellent";
    // Future: 3 hours excellent, then 5 hours good.
    for (let i = 12; i < 15; i++) levels[i] = "excellent";
    for (let i = 15; i < 20; i++) levels[i] = "good";
    const window = bestWindow(cellsFrom(levels));
    // Excellent and good hours form one contiguous workable stretch.
    expect(window).toEqual(
      expect.objectContaining({ start: 12, end: 20, level: "good" }),
    );
  });

  it("returns null when nothing in the future is good or better", () => {
    expect(bestWindow(cellsFrom(Array(24).fill("poor")))).toBeNull();
  });
});

describe("laneSummary", () => {
  it("reads as sentences a screen reader can use", () => {
    const levels: LaneCell["level"][] =
      Array<LaneCell["level"]>(24).fill("poor");
    for (let i = 12; i < 16; i++) levels[i] = "excellent";
    const text = laneSummary("Farming", cellsFrom(levels));
    expect(text).toContain("Farming:");
    expect(text).toContain("Excellent 10:00 to 14:00");
    expect(text).toContain("Best window 10:00 to 14:00.");
  });

  it("says so when there is no forecast", () => {
    expect(laneSummary("Farming", cellsFrom(Array(24).fill(null)))).toBe(
      "Farming: no forecast for this activity yet.",
    );
  });
});

describe("groupReportsByHour", () => {
  it("groups by hour and type, most frequent type first", () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 8, h, m).toISOString();
    const groups = groupReportsByHour(
      [
        { id: "a", reportType: "hail", reportedAt: at(15, 5) },
        { id: "b", reportType: "hail", reportedAt: at(15, 40) },
        { id: "c", reportType: "heavy-rain", reportedAt: at(15, 10) },
        { id: "d", reportType: "fog", reportedAt: at(8, 0) },
        {
          id: "old",
          reportType: "fog",
          reportedAt: new Date(2026, 9, 7, 20, 0).toISOString(),
        },
      ],
      NOW,
    );
    expect(groups.get(17)).toEqual({
      index: 17,
      total: 3,
      counts: [
        { type: "hail", count: 2 },
        { type: "heavy-rain", count: 1 },
      ],
    });
    expect(groups.get(10)?.total).toBe(1);
    // 20:00 yesterday falls before the window and is dropped.
    expect(groups.size).toBe(2);
  });

  it("ignores unparseable timestamps", () => {
    expect(
      groupReportsByHour(
        [{ id: "x", reportType: "fog", reportedAt: "not a date" }],
        NOW,
      ).size,
    ).toBe(0);
  });
});

describe("assignPinTiers", () => {
  it("keeps pins on one tier when they are far enough apart", () => {
    expect(assignPinTiers([1, 6, 11])).toEqual(
      new Map([
        [1, 0],
        [6, 0],
        [11, 0],
      ]),
    );
  });

  it("moves a pin that would overlap onto the next tier", () => {
    const tiers = assignPinTiers([10, 11, 12, 13]);
    expect(tiers.get(10)).toBe(0);
    expect(tiers.get(11)).toBe(1);
    expect(tiers.get(12)).toBe(2);
    // Out of tiers: shares the last one rather than inventing a fourth row.
    expect(tiers.get(13)).toBe(2);
  });
});
