import { describe, it, expect } from "vitest";
import {
  cardTheme,
  cardConditionLabel,
  resolveUtcOffsetSeconds,
  FIXED_UTC_OFFSET_SECONDS,
  localTimeLabel,
  tempLabel,
  highLowLabel,
  summarizeCardWeather,
  cardAccessibleName,
  buildLocationList,
  cardHref,
  type CardWeatherInput,
} from "./location-card";

describe("cardTheme — WMO code + day/night → sky class", () => {
  it("clear and mainly clear are blue sky by day and navy by night", () => {
    expect(cardTheme(0, true)).toBe("oryx-clear-day");
    expect(cardTheme(1, true)).toBe("oryx-clear-day");
    expect(cardTheme(0, false)).toBe("oryx-clear-night");
    expect(cardTheme(1, false)).toBe("oryx-clear-night");
  });

  it("partly cloudy keeps the clear sky, day and night", () => {
    expect(cardTheme(2, true)).toBe("oryx-clear-day");
    expect(cardTheme(2, false)).toBe("oryx-clear-night");
  });

  it("overcast is cloudy regardless of day/night", () => {
    expect(cardTheme(3, true)).toBe("oryx-cloudy");
    expect(cardTheme(3, false)).toBe("oryx-cloudy");
  });

  it("fog and rime fog are the fog sky", () => {
    expect(cardTheme(45, true)).toBe("oryx-fog");
    expect(cardTheme(48, false)).toBe("oryx-fog");
  });

  it("drizzle, rain, freezing rain and showers are the rain sky", () => {
    expect(cardTheme(51, true)).toBe("oryx-rain");
    expect(cardTheme(57, true)).toBe("oryx-rain");
    expect(cardTheme(63, false)).toBe("oryx-rain");
    expect(cardTheme(67, true)).toBe("oryx-rain");
    expect(cardTheme(81, true)).toBe("oryx-rain");
  });

  it("thunderstorms (95-99) are the storm sky", () => {
    expect(cardTheme(95, true)).toBe("oryx-storm");
    expect(cardTheme(99, false)).toBe("oryx-storm");
  });

  it("snow grains, snow and snow showers are the snow sky", () => {
    expect(cardTheme(71, true)).toBe("oryx-snow");
    expect(cardTheme(77, true)).toBe("oryx-snow");
    expect(cardTheme(86, false)).toBe("oryx-snow");
  });

  it("unknown codes fall back to cloudy rather than a clear sky", () => {
    expect(cardTheme(-1, true)).toBe("oryx-cloudy");
    expect(cardTheme(42, true)).toBe("oryx-cloudy");
  });
});

describe("cardConditionLabel", () => {
  it("title-cases the shared WMO label", () => {
    expect(cardConditionLabel(2)).toBe("Partly Cloudy");
    expect(cardConditionLabel(3)).toBe("Overcast");
    expect(cardConditionLabel(0)).toBe("Clear Sky");
  });
});

describe("resolveUtcOffsetSeconds", () => {
  it("prefers an explicit offset from the payload", () => {
    expect(resolveUtcOffsetSeconds(19800, 31.04, "ZW")).toBe(19800);
  });

  it("rounds a non-integer explicit offset", () => {
    expect(resolveUtcOffsetSeconds(7199.6, 0, null)).toBe(7200);
  });

  it("uses the fixed-offset country table when no explicit offset", () => {
    expect(resolveUtcOffsetSeconds(undefined, 31.04, "ZW")).toBe(7200);
    expect(resolveUtcOffsetSeconds(null, 100.5, "th")).toBe(25200);
    expect(resolveUtcOffsetSeconds(undefined, 77, "IN")).toBe(19800);
  });

  it("estimates from longitude (15°/hour, quarter-hour rounding) otherwise", () => {
    // 15° → +1h, 37.5° → +2.5h, -90° → -6h
    expect(resolveUtcOffsetSeconds(undefined, 15, "XX")).toBe(3600);
    expect(resolveUtcOffsetSeconds(undefined, 37.5, null)).toBe(9000);
    expect(resolveUtcOffsetSeconds(undefined, -90, undefined)).toBe(-21600);
  });

  it("returns 0 for a non-finite longitude with no other source", () => {
    expect(resolveUtcOffsetSeconds(undefined, Number.NaN, null)).toBe(0);
  });

  it("only lists fixed-offset countries (no DST zones in the table)", () => {
    // Spot-check that DST-observing countries are absent by design.
    expect(FIXED_UTC_OFFSET_SECONDS.GB).toBeUndefined();
    expect(FIXED_UTC_OFFSET_SECONDS.AU).toBeUndefined();
    expect(FIXED_UTC_OFFSET_SECONDS.US).toBeUndefined();
  });
});

describe("localTimeLabel", () => {
  it("formats the wall-clock time at the place from a UTC instant", () => {
    // 15:03 UTC at +2h → 17:03 local
    expect(localTimeLabel("2026-10-08T15:03:00Z", 7200)).toBe("17:03");
  });

  it("wraps across midnight in both directions", () => {
    expect(localTimeLabel("2026-10-08T23:30:00Z", 3600)).toBe("00:30");
    expect(localTimeLabel("2026-10-08T01:15:00Z", -18000)).toBe("20:15");
  });

  it("pads single-digit hours and minutes", () => {
    expect(localTimeLabel("2026-10-08T00:05:00Z", 0)).toBe("00:05");
  });

  it("accepts a Date or epoch milliseconds", () => {
    const d = new Date("2026-10-08T12:00:00Z");
    expect(localTimeLabel(d, 19800)).toBe("17:30");
    expect(localTimeLabel(d.getTime(), 19800)).toBe("17:30");
  });

  it("returns an empty string for an unparseable instant", () => {
    expect(localTimeLabel("not a date", 0)).toBe("");
  });
});

describe("temperature and high/low labels", () => {
  it("rounds to whole degrees", () => {
    expect(tempLabel(25.4)).toBe("25°");
    expect(tempLabel(25.5)).toBe("26°");
    expect(tempLabel(-0.6)).toBe("-1°");
  });

  it("formats the iOS-style H/L line with rounding", () => {
    expect(highLowLabel(26.6, 16.4)).toBe("H:27° L:16°");
  });
});

const payload: CardWeatherInput = {
  current: { temperature_2m: 25.2, weather_code: 3, is_day: 1 },
  daily: {
    temperature_2m_max: [26.7, 27.9],
    temperature_2m_min: [16.6, 15],
  },
};

describe("summarizeCardWeather", () => {
  it("builds the card model from a weather payload", () => {
    const s = summarizeCardWeather(payload, 31.04, "ZW");
    expect(s).toEqual({
      temperature: 25.2,
      weatherCode: 3,
      isDay: true,
      high: 26.7,
      low: 16.6,
      condition: "Overcast",
      sky: "oryx-cloudy",
      utcOffsetSeconds: 7200,
    });
  });

  it("treats is_day 0 as night", () => {
    const s = summarizeCardWeather(
      {
        ...payload,
        current: { ...payload.current, weather_code: 0, is_day: 0 },
      },
      31,
      "ZW",
    );
    expect(s?.sky).toBe("oryx-clear-night");
    expect(s?.isDay).toBe(false);
  });

  it("uses an explicit utc_offset_seconds when the payload supplies one", () => {
    const s = summarizeCardWeather(
      { ...payload, utc_offset_seconds: 3600 },
      31,
      "ZW",
    );
    expect(s?.utcOffsetSeconds).toBe(3600);
  });

  it("returns null when required fields are missing", () => {
    expect(summarizeCardWeather(null, 0)).toBeNull();
    expect(summarizeCardWeather(undefined, 0)).toBeNull();
    expect(
      summarizeCardWeather(
        {
          ...payload,
          daily: { temperature_2m_max: [], temperature_2m_min: [] },
        },
        0,
      ),
    ).toBeNull();
  });
});

describe("cardAccessibleName", () => {
  const summary = summarizeCardWeather(payload, 31.04, "ZW");

  it("reads as name, temperature, condition, then high and low", () => {
    expect(cardAccessibleName({ name: "Harare", summary })).toBe(
      "Harare, 25°, Overcast, high 27 low 17",
    );
  });

  it("says weather is unavailable when there is no summary", () => {
    expect(cardAccessibleName({ name: "Harare", summary: null })).toBe(
      "Harare, Weather unavailable",
    );
  });

  it("appends the current-location and home badges", () => {
    expect(
      cardAccessibleName({
        name: "Harare",
        summary,
        isCurrent: true,
        isHome: true,
      }),
    ).toBe("Harare, 25°, Overcast, high 27 low 17, My location, Home");
  });
});

describe("buildLocationList", () => {
  it("puts the current location first, then saved places in order", () => {
    expect(buildLocationList("harare", ["bulawayo", "mutare"], 10)).toEqual([
      { slug: "harare", isCurrent: true },
      { slug: "bulawayo", isCurrent: false },
      { slug: "mutare", isCurrent: false },
    ]);
  });

  it("does not repeat a saved place that is the current location", () => {
    expect(buildLocationList("harare", ["harare", "bulawayo"], 10)).toEqual([
      { slug: "harare", isCurrent: true },
      { slug: "bulawayo", isCurrent: false },
    ]);
  });

  it("omits the current entry when there is no current location", () => {
    expect(buildLocationList(null, ["bulawayo"], 10)).toEqual([
      { slug: "bulawayo", isCurrent: false },
    ]);
  });

  it("caps saved places at the given limit and drops empty slugs", () => {
    expect(buildLocationList(null, ["a", "", "b", "c"], 2)).toEqual([
      { slug: "a", isCurrent: false },
    ]);
  });

  it("returns an empty list when nothing is known", () => {
    expect(buildLocationList(null, [], 10)).toEqual([]);
  });
});

describe("cardHref", () => {
  it("links the current location to / and saved places to /{slug}", () => {
    expect(cardHref({ slug: "harare", isCurrent: true })).toBe("/");
    expect(cardHref({ slug: "bulawayo", isCurrent: false })).toBe("/bulawayo");
  });
});

// ---------------------------------------------------------------------------
// Mineral plates, the per-slug cache and the batch loader
// ---------------------------------------------------------------------------

import {
  CARD_FETCH_CONCURRENCY,
  CARD_WEATHER_TTL_MS,
  PLATE_CLASSES,
  PLATE_MINERAL,
  TtlCache,
  mapWithConcurrency,
  plateClassesFor,
  plateConditionFor,
  plateName,
} from "./location-card";

describe("plate names and minerals", () => {
  it("names plates plate-<condition>-<day|night>", () => {
    expect(plateName("clear", true)).toBe("plate-clear-day");
    expect(plateName("rain", false)).toBe("plate-rain-night");
  });

  it("maps every condition, day and night, to a mineral", () => {
    const conditions = ["clear", "cloudy", "rain", "storm", "fog", "snow"] as const;
    for (const condition of conditions) {
      for (const isDay of [true, false]) {
        expect(PLATE_MINERAL[plateName(condition, isDay)]).toBeDefined();
      }
    }
  });

  it("gives clear day and night different minerals", () => {
    expect(PLATE_MINERAL["plate-clear-day"]).not.toBe(
      PLATE_MINERAL["plate-clear-night"],
    );
  });

  it("maps sky classes to condition families", () => {
    expect(plateConditionFor("oryx-clear-day")).toBe("clear");
    expect(plateConditionFor("oryx-clear-night")).toBe("clear");
    expect(plateConditionFor("oryx-rain")).toBe("rain");
    expect(plateConditionFor("oryx-storm")).toBe("storm");
    expect(plateConditionFor("oryx-fog")).toBe("fog");
    expect(plateConditionFor("oryx-snow")).toBe("snow");
    expect(plateConditionFor("oryx-cloudy")).toBe("cloudy");
  });

  it("returns literal plate and edge classes for a card", () => {
    const classes = plateClassesFor("oryx-rain", true);
    expect(classes).toBe(PLATE_CLASSES.malachite);
    expect(classes.plate).toContain("color-mix(");
    expect(classes.plate).toContain("var(--mineral-malachite)");
    expect(classes.edge).toBe("border-l-[var(--mineral-malachite)]");
  });

  it("uses no hardcoded hex or rgba in plate classes", () => {
    for (const { plate, edge } of Object.values(PLATE_CLASSES)) {
      expect(`${plate} ${edge}`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    }
  });
});

describe("TtlCache", () => {
  it("returns a value until its TTL passes, then drops it", () => {
    let now = 0;
    const cache = new TtlCache<string>(1000, () => now);
    cache.set("harare", "weather");
    now = 999;
    expect(cache.get("harare")).toBe("weather");
    now = 1000;
    expect(cache.get("harare")).toBeUndefined();
  });

  it("returns undefined for unknown keys and supports delete and clear", () => {
    const cache = new TtlCache<number>(1000);
    expect(cache.get("nope")).toBeUndefined();
    cache.set("a", 1);
    cache.set("b", 2);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    cache.clear();
    expect(cache.get("b")).toBeUndefined();
  });

  it("uses a 10-minute TTL for the Locations list", () => {
    expect(CARD_WEATHER_TTL_MS).toBe(10 * 60 * 1000);
  });
});

describe("mapWithConcurrency", () => {
  it("runs at most the limit of workers at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return n;
    });
    expect(peak).toBe(3);
  });

  it("keeps results in input order even when workers finish out of order", async () => {
    const out = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await mapWithConcurrency([], 3, async (n: number) => n)).toEqual([]);
    expect(
      await mapWithConcurrency([1, 2], 10, async (n) => n * 2),
    ).toEqual([2, 4]);
  });

  it("defaults the card fetch concurrency to 3", () => {
    expect(CARD_FETCH_CONCURRENCY).toBe(3);
  });
});
