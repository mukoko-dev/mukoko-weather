/**
 * Location time — "the current hour" and every hour label follow the
 * LOCATION's time zone, whoever is looking and wherever they are.
 *
 * The two required scenarios run with the process time zone actually set to
 * the viewer's zone (Node re-reads `process.env.TZ` on assignment), so any
 * code path that still reads the viewer's clock fails here:
 *
 *   1. a viewer in UTC+8 (Perth) looking at Harare (UTC+2, naive
 *      Open-Meteo wall-clock strings)
 *   2. a viewer in UTC-5 (Bogotá) looking at Singapore (UTC+8, zoned
 *      Tomorrow.io instants)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HourlyWeather, WeatherData } from "./weather";
import { checkFrostRisk, createFallbackWeather } from "./weather";
import type { SuitabilityRuleDoc } from "./db";
import {
  currentHourIndex,
  hasZone,
  instantMs,
  locationClockLabel,
  locationDateString,
  locationHourLabel,
  locationHourNow,
  longitudeOffsetSeconds,
  resolveOffsetSeconds,
  viewerOffsetSeconds,
  wallClockMs,
} from "./location-time";
import {
  currentHourIndex as heroCurrentHourIndex,
  heroActivityClause,
  heroOutlook,
} from "./hero";
import { hourlySummary } from "./hourly-summary";
import { feasibilitySeries } from "./activity-feasibility";
import { getActivityTips } from "./activity-tips";
import {
  buildLaneCells,
  formatLaneHour,
  groupReportsByHour,
  laneBaseMs,
  laneSummary,
} from "./community-lane";
import { currentHourIndex as displayCurrentHourIndex } from "./display";
import { prepareHourlyData } from "@/components/weather/HourlyChart";
import { prepareAtmosphericData } from "@/components/weather/AtmosphericDetails";
import {
  localIsoDate,
  next24hPrecipSeries,
} from "@/components/weather/AtmosphericSummary";
import { prepareFeasibilityData } from "@/components/weather/charts/FeasibilityChart";
import { sunInsight } from "./metric-insights";

const HOUR = 3_600_000;
const HARARE = 7200; // UTC+2
const SINGAPORE = 28800; // UTC+8

const pad = (n: number) => String(n).padStart(2, "0");

/** 48 hours of hourly data; `time[i]` from `timeAt(i)`, code from `codeAt(i)`. */
function hourly(
  timeAt: (i: number) => string,
  codeAt: (i: number) => number = () => 0,
  n = 48,
): HourlyWeather {
  const fill = (v: number) => Array.from({ length: n }, () => v);
  return {
    time: Array.from({ length: n }, (_, i) => timeAt(i)),
    weather_code: Array.from({ length: n }, (_, i) => codeAt(i)),
    temperature_2m: Array.from({ length: n }, (_, i) => i), // temp == index
    apparent_temperature: fill(20),
    relative_humidity_2m: fill(50),
    precipitation_probability: fill(0),
    precipitation: Array.from({ length: n }, (_, i) => i / 10),
    visibility: fill(20000),
    cloud_cover: fill(20),
    surface_pressure: fill(1010),
    wind_speed_10m: fill(5),
    wind_direction_10m: fill(90),
    wind_gusts_10m: fill(8),
    uv_index: fill(3),
    is_day: fill(1),
  };
}

/** Open-Meteo style: naive local strings from local midnight, 2026-10-08. */
function harareHourly(codeAt?: (i: number) => number): HourlyWeather {
  return hourly((i) => {
    const day = 8 + Math.floor(i / 24);
    return `2026-10-${pad(day)}T${pad(i % 24)}:00`;
  }, codeAt);
}

/** Tomorrow.io style: zoned UTC instants from Singapore local midnight. */
function singaporeHourly(codeAt?: (i: number) => number): HourlyWeather {
  // Singapore 2026-10-08 00:00 = 2026-10-07 16:00 UTC
  const start = Date.UTC(2026, 9, 7, 16, 0, 0);
  return hourly(
    (i) => new Date(start + i * HOUR).toISOString().replace(".000Z", "Z"),
    codeAt,
  );
}

function weather(
  h: HourlyWeather,
  offset: number,
  daily?: Partial<WeatherData["daily"]>,
): WeatherData {
  return {
    current: {
      temperature_2m: 20,
      relative_humidity_2m: 50,
      apparent_temperature: 20,
      precipitation: 0,
      weather_code: 0,
      cloud_cover: 20,
      wind_speed_10m: 5,
      wind_direction_10m: 90,
      wind_gusts_10m: 8,
      uv_index: 3,
      surface_pressure: 1010,
      is_day: 1,
    },
    hourly: h,
    daily: {
      time: [],
      weather_code: [],
      temperature_2m_max: [],
      temperature_2m_min: [],
      apparent_temperature_max: [],
      apparent_temperature_min: [],
      sunrise: [],
      sunset: [],
      uv_index_max: [],
      precipitation_sum: [],
      precipitation_probability_max: [],
      wind_speed_10m_max: [],
      wind_gusts_10m_max: [],
      ...daily,
    },
    current_units: {},
    utc_offset_seconds: offset,
  };
}

const rules = new Map<string, SuitabilityRuleDoc>([
  [
    "category:farming",
    {
      key: "category:farming",
      conditions: [
        {
          field: "precipitationType",
          operator: "gte",
          value: 1,
          level: "poor",
          label: "Poor",
          colorClass: "",
          bgClass: "",
          detail: "Wet",
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

/** Run a describe block with the process clock set to a viewer's zone. */
function inViewerZone(
  tz: string,
  expectedOffsetMinutes: number,
  fn: () => void,
) {
  describe(`viewer in ${tz}`, () => {
    let prev: string | undefined;
    beforeAll(() => {
      prev = process.env.TZ;
      process.env.TZ = tz;
    });
    afterAll(() => {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    });
    it("really runs in the viewer's zone (precondition)", () => {
      expect(-new Date(Date.UTC(2026, 9, 8)).getTimezoneOffset()).toBe(
        expectedOffsetMinutes,
      );
    });
    fn();
  });
}

// ---------------------------------------------------------------------------
// Scenario 1 — viewer in UTC+8 (Perth) looking at Harare (UTC+2)
// ---------------------------------------------------------------------------

inViewerZone("Australia/Perth", 480, () => {
  // 06:30 UTC → 14:30 in Perth, 08:30 in Harare.
  const NOW = new Date(Date.UTC(2026, 9, 8, 6, 30));
  // Rain from Harare 10:00 onwards (index 10).
  const h = harareHourly((i) => (i >= 10 ? 61 : 0));
  const w = weather(h, HARARE, {
    time: ["2026-10-08", "2026-10-09"],
    sunrise: ["2026-10-08T05:46", "2026-10-09T05:45"],
    sunset: ["2026-10-08T18:11", "2026-10-09T18:12"],
  });

  it("starts at Harare's 08:00, not Perth's 14:00", () => {
    expect(currentHourIndex(h.time, HARARE, NOW)).toBe(8);
    expect(heroCurrentHourIndex(h.time, NOW, HARARE)).toBe(8);
    expect(displayCurrentHourIndex(h.time, NOW, HARARE)).toBe(8);
    expect(locationHourNow(HARARE, NOW)).toBe(8);
    expect(locationDateString(HARARE, NOW)).toBe("2026-10-08");
  });

  it("labels hours on Harare's clock", () => {
    expect(locationHourLabel(h.time[8], HARARE)).toBe("08:00");
    const chart = prepareHourlyData(h, HARARE, NOW);
    expect(chart[0].label).toBe("Now");
    expect(chart[0].temp).toBe(8);
    expect(chart[1].label).toBe("09:00");
    const atmos = prepareAtmosphericData(h, HARARE, NOW);
    expect(atmos[1].label).toBe("09:00");
  });

  it("hero outlook names Harare's rain hour", () => {
    expect(heroOutlook(h, NOW, HARARE)).toMatch(/around 10:00/);
    expect(hourlySummary(h, 8, HARARE)).toMatch(/around 10:00/);
  });

  it("feasibility and the activity clause follow Harare", () => {
    const series = feasibilitySeries(farming, h, rules, 24, HARARE, NOW);
    expect(series[0].time).toBe("2026-10-08T08:00");
    expect(series[0].label).toBe("08:00");
    expect(prepareFeasibilityData(series)[0].label).toBe("08:00");
    expect(heroActivityClause(series, HARARE)).toBe("good until 10:00");
  });

  it("community lane cells and labels are Harare hours", () => {
    const base = laneBaseMs(NOW, HARARE);
    // Harare 08:00 minus 12 h = 20:00 Harare on the 7th = 18:00 UTC.
    expect(base).toBe(Date.UTC(2026, 9, 7, 18, 0));
    expect(formatLaneHour(base, HARARE)).toBe("20:00");
    const cells = buildLaneCells(farming, h, rules, NOW, HARARE);
    expect(formatLaneHour(cells[12].at, HARARE)).toBe("08:00");
    expect(cells[12].level).toBe("good"); // index 8 — dry
    expect(cells[14].level).toBe("poor"); // Harare 10:00 — rain
    expect(laneSummary("Farming", cells, HARARE)).toBe(
      "Farming: Good 00:00 to 10:00, Poor 10:00 to 20:00. Best window 08:00 to 10:00.",
    );
    const pins = groupReportsByHour(
      [
        {
          id: "a",
          reportType: "heavy-rain",
          reportedAt: "2026-10-08T06:10:00Z",
        },
      ],
      NOW,
      HARARE,
    );
    expect([...pins.keys()]).toEqual([12]);
  });

  it("rain series and normals date are Harare's", () => {
    expect(next24hPrecipSeries(h, NOW, HARARE)[0]).toBeCloseTo(0.8);
    expect(localIsoDate(NOW, HARARE)).toBe("2026-10-08");
  });

  it("sun card reads Harare's sunset as the next event", () => {
    const sun = sunInsight(w, NOW);
    expect(sun.sunrise).toBe("05:46");
    expect(sun.sunset).toBe("18:11");
  });

  it("activity tips label Harare hours", () => {
    const wet = weather(
      harareHourly(() => 0),
      HARARE,
    );
    wet.hourly.precipitation_probability = wet.hourly.time.map((_, i) =>
      i === 11 ? 90 : 0,
    );
    const tips = getActivityTips(
      { id: "crop-farming", category: "farming" } as never,
      wet,
    );
    // Any time mentioned is a Harare hour (11:00), never Perth's 17:00.
    const joined = tips.join(" ");
    expect(joined).not.toMatch(/17:00/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — viewer in UTC-5 (Bogotá) looking at Singapore (UTC+8)
// ---------------------------------------------------------------------------

inViewerZone("America/Bogota", -300, () => {
  // 03:15 UTC → 22:15 on the 7th in Bogotá, 11:15 on the 8th in Singapore.
  const NOW = new Date(Date.UTC(2026, 9, 8, 3, 15));
  // Storm from Singapore 14:00 (index 14).
  const h = singaporeHourly((i) => (i >= 14 ? 95 : 1));
  const w = weather(h, SINGAPORE, {
    time: ["2026-10-08", "2026-10-09"],
    sunrise: ["2026-10-07T22:57:00Z", "2026-10-08T22:57:00Z"],
    sunset: ["2026-10-08T11:03:00Z", "2026-10-09T11:03:00Z"],
  });

  it("starts at Singapore's 11:00, not Bogotá's 22:00", () => {
    expect(currentHourIndex(h.time, SINGAPORE, NOW)).toBe(11);
    expect(heroCurrentHourIndex(h.time, NOW, SINGAPORE)).toBe(11);
    expect(displayCurrentHourIndex(h.time, NOW, SINGAPORE)).toBe(11);
    expect(locationDateString(SINGAPORE, NOW)).toBe("2026-10-08");
  });

  it("labels zoned instants on Singapore's clock", () => {
    expect(h.time[11]).toBe("2026-10-08T03:00:00Z");
    expect(locationHourLabel(h.time[11], SINGAPORE)).toBe("11:00");
    const chart = prepareHourlyData(h, SINGAPORE, NOW);
    expect(chart[0].temp).toBe(11);
    expect(chart[1].label).toBe("12:00");
    expect(prepareAtmosphericData(h, SINGAPORE, NOW)[2].label).toBe("13:00");
  });

  it("hero outlook names Singapore's storm hour", () => {
    expect(heroOutlook(h, NOW, SINGAPORE)).toMatch(/around 14:00/);
  });

  it("feasibility starts at Singapore's current hour", () => {
    const series = feasibilitySeries(farming, h, rules, 24, SINGAPORE, NOW);
    expect(series[0].label).toBe("11:00");
    expect(heroActivityClause(series, SINGAPORE)).toBe("good until 14:00");
  });

  it("community lane maps zoned forecast hours onto Singapore cells", () => {
    const cells = buildLaneCells(farming, h, rules, NOW, SINGAPORE);
    expect(formatLaneHour(cells[12].at, SINGAPORE)).toBe("11:00");
    expect(cells[12].level).toBe("good");
    expect(cells[15].level).toBe("poor");
  });

  it("rain series, normals date and sun times are Singapore's", () => {
    expect(next24hPrecipSeries(h, NOW, SINGAPORE)[0]).toBeCloseTo(1.1);
    expect(localIsoDate(NOW, SINGAPORE)).toBe("2026-10-08");
    const sun = sunInsight(w, NOW);
    expect(sun.sunrise).toBe("06:57");
    expect(sun.sunset).toBe("19:03");
  });

  it("frost hours are read on the location's night", () => {
    const cold = singaporeHourly();
    // Singapore 23:00 (index 23) is cold; Bogotá would call it 10:00.
    cold.temperature_2m = cold.temperature_2m.map((_, i) =>
      i === 23 ? 1 : 20,
    );
    expect(checkFrostRisk(cold, SINGAPORE)?.lowestTemp).toBe(1);
    // Singapore 13:00 cold is daytime — no frost alert.
    cold.temperature_2m = cold.temperature_2m.map((_, i) =>
      i === 13 ? 1 : 20,
    );
    expect(checkFrostRisk(cold, SINGAPORE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("location-time helpers", () => {
  it("tells zoned instants from naive wall-clock strings", () => {
    expect(hasZone("2026-10-08T14:00")).toBe(false);
    expect(hasZone("2026-10-08T14:00:00")).toBe(false);
    expect(hasZone("2026-10-08")).toBe(false);
    expect(hasZone("2026-10-08T14:00:00Z")).toBe(true);
    expect(hasZone("2026-10-08T14:00:00+00:00")).toBe(true);
    expect(hasZone("2026-10-08T14:00-05:00")).toBe(true);
  });

  it("wall clock and instant agree for both string kinds", () => {
    const naive = "2026-10-08T14:00";
    expect(wallClockMs(naive, HARARE)).toBe(Date.UTC(2026, 9, 8, 14));
    expect(instantMs(naive, HARARE)).toBe(Date.UTC(2026, 9, 8, 12));
    const zoned = "2026-10-08T12:00:00Z";
    expect(wallClockMs(zoned, HARARE)).toBe(Date.UTC(2026, 9, 8, 14));
    expect(instantMs(zoned, HARARE)).toBe(Date.UTC(2026, 9, 8, 12));
    expect(wallClockMs("garbage", HARARE)).toBeNull();
    expect(wallClockMs(undefined, HARARE)).toBeNull();
  });

  it("half-hour zones label their own hours", () => {
    // India UTC+05:30 — 2026-10-08T06:30Z is 12:00 IST.
    expect(locationClockLabel("2026-10-08T06:30:00Z", 19800)).toBe("12:00");
    expect(locationHourNow(19800, new Date(Date.UTC(2026, 9, 8, 6, 45)))).toBe(
      12,
    );
  });

  it("crosses the date line on the location's calendar", () => {
    // 2026-10-08T20:00Z is already the 9th in Auckland (UTC+13 in October).
    expect(locationDateString(46800, new Date(Date.UTC(2026, 9, 8, 20)))).toBe(
      "2026-10-09",
    );
  });

  it("an explicit offset always wins; missing falls back to the viewer", () => {
    expect(resolveOffsetSeconds(0)).toBe(0);
    expect(resolveOffsetSeconds(-18000)).toBe(-18000);
    const now = new Date();
    expect(resolveOffsetSeconds(undefined, now)).toBe(viewerOffsetSeconds(now));
    expect(resolveOffsetSeconds(Number.NaN, now)).toBe(
      viewerOffsetSeconds(now),
    );
  });

  it("returns 0 for an empty or stale series", () => {
    expect(currentHourIndex([], HARARE)).toBe(0);
    expect(currentHourIndex(["2000-01-01T00:00"], HARARE)).toBe(0);
  });

  it("estimates an offset from longitude in quarter hours", () => {
    expect(longitudeOffsetSeconds(31.05)).toBe(7200);
    expect(longitudeOffsetSeconds(-74)).toBe(-18000);
    expect(longitudeOffsetSeconds(82.5)).toBe(19800);
    expect(longitudeOffsetSeconds(Number.NaN)).toBe(0);
  });

  it("the seasonal fallback is built on the location's wall clock", () => {
    const fb = createFallbackWeather(-17.83, 31.05, 1490);
    expect(fb.utc_offset_seconds).toBe(7200);
    expect(fb.utc_offset_estimated).toBe(true);
    expect(fb.hourly.time.every((t) => !hasZone(t))).toBe(true);
    // The first fallback hour IS the location's current hour.
    expect(currentHourIndex(fb.hourly.time, 7200)).toBe(0);
    expect(fb.daily.sunrise[0]).toBe(`${fb.daily.time[0]}T05:45`);
  });
});
