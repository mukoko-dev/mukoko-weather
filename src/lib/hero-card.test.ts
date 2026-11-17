import { describe, expect, it } from "vitest";
import {
  HERO_CURVE_BOX,
  HERO_CURVE_DEFAULT_WIDTH,
  curveLabelAnchor,
  curveLabelSpan,
  formatDegrees,
  heroDayCurve,
  heroHourStrip,
  heroReadings,
  heroSeriesStart,
  roundTemp,
} from "./hero-card";
import type { HourlyWeather } from "./weather";

/** Harare is UTC+2 all year. */
const OFFSET = 7200;
/** 14:10 in Harare on 2026-11-17: the instant is 12:10 UTC. */
const NOW = new Date(Date.UTC(2026, 10, 17, 12, 10));

/**
 * An hourly series of `temps` as the place's naive wall-clock strings (the
 * Open-Meteo `timezone=auto` form), the first slot at `from`.
 */
function hourlyOf(
  temps: Array<number | null>,
  from = "2026-11-17T00:00",
): HourlyWeather {
  const start = Date.parse(`${from}:00Z`);
  const time = temps.map((_, i) =>
    new Date(start + i * 3_600_000).toISOString().slice(0, 16),
  );
  const zeros = temps.map(() => 0);
  return {
    time,
    temperature_2m: temps as number[],
    apparent_temperature: zeros,
    relative_humidity_2m: zeros,
    precipitation_probability: zeros,
    precipitation: zeros,
    weather_code: zeros,
    visibility: zeros,
    cloud_cover: zeros,
    surface_pressure: zeros,
    wind_speed_10m: zeros,
    wind_direction_10m: zeros,
    wind_gusts_10m: zeros,
    uv_index: zeros,
    is_day: temps.map(() => 1),
  };
}

/** 48 hours from midnight: 14:00 today is index 14. */
const DAY_TEMPS = Array.from({ length: 48 }, (_, i) => 20 + (i % 24) / 2);

describe("roundTemp and formatDegrees", () => {
  it("rounds to a whole degree and never prints -0", () => {
    expect(roundTemp(27.6)).toBe(28);
    expect(roundTemp(-0.4)).toBe(0);
    expect(Object.is(roundTemp(-0.4), -0)).toBe(false);
    expect(formatDegrees(-0.4)).toBe("0°");
    expect(formatDegrees(-3.2)).toBe("-3°");
    expect(formatDegrees(12)).toBe("12°");
  });
});

describe("heroSeriesStart", () => {
  it("finds the place's current hour, not the viewer's", () => {
    // 12:10 UTC is 14:10 in Harare: slot 14. The same instant is 07:10 in a
    // place at UTC-5: slot 7. The answer follows the place's offset, whatever
    // TZ the runner has.
    expect(heroSeriesStart(hourlyOf(DAY_TEMPS), NOW, OFFSET)).toBe(14);
    expect(heroSeriesStart(hourlyOf(DAY_TEMPS), NOW, -18000)).toBe(7);
  });

  it("is null for a missing, empty or out-of-step series", () => {
    expect(heroSeriesStart(undefined, NOW, OFFSET)).toBeNull();
    expect(heroSeriesStart(null, NOW, OFFSET)).toBeNull();
    expect(heroSeriesStart(hourlyOf([]), NOW, OFFSET)).toBeNull();
    const broken = {
      ...hourlyOf(DAY_TEMPS),
      temperature_2m: undefined,
    } as unknown as HourlyWeather;
    expect(heroSeriesStart(broken, NOW, OFFSET)).toBeNull();
  });

  it("is null for a series that ended before now, never 'Now' on old hours", () => {
    const yesterday = hourlyOf(DAY_TEMPS.slice(0, 24), "2026-11-15T00:00");
    expect(heroSeriesStart(yesterday, NOW, OFFSET)).toBeNull();
  });

  it("is null when the series has a gap at the current hour", () => {
    const gap = hourlyOf(DAY_TEMPS);
    gap.time.splice(14, 1);
    gap.temperature_2m.splice(14, 1);
    expect(heroSeriesStart(gap, NOW, OFFSET)).toBeNull();
  });

  it("reads zoned instants in the place's offset too", () => {
    const zoned = hourlyOf(DAY_TEMPS);
    zoned.time = zoned.time.map((t) => `${t}:00+02:00`);
    expect(heroSeriesStart(zoned, NOW, OFFSET)).toBe(14);
  });
});

describe("heroHourStrip", () => {
  it("is Now and the next four hours, labelled in the place's clock", () => {
    const strip = heroHourStrip(hourlyOf(DAY_TEMPS), NOW, OFFSET, 27.6);
    expect(strip.map((h) => h.label)).toEqual([
      "Now",
      "15:00",
      "16:00",
      "17:00",
      "18:00",
    ]);
    // "Now" is the hero numeral, the rest are the series.
    expect(strip[0].temperature).toBe(27.6);
    expect(strip[1].temperature).toBe(DAY_TEMPS[15]);
    expect(new Set(strip.map((h) => h.time)).size).toBe(5);
  });

  it("takes the first hour from the series when there is no current temperature", () => {
    const strip = heroHourStrip(hourlyOf(DAY_TEMPS), NOW, OFFSET);
    expect(strip[0].temperature).toBe(DAY_TEMPS[14]);
    const nan = heroHourStrip(hourlyOf(DAY_TEMPS), NOW, OFFSET, Number.NaN);
    expect(nan[0].temperature).toBe(DAY_TEMPS[14]);
  });

  it("is empty when hourly is missing, stale or has a single hour", () => {
    expect(heroHourStrip(undefined, NOW, OFFSET, 20)).toEqual([]);
    expect(heroHourStrip(hourlyOf([]), NOW, OFFSET, 20)).toEqual([]);
    expect(
      heroHourStrip(hourlyOf([1, 2], "2026-11-10T00:00"), NOW, OFFSET, 20),
    ).toEqual([]);
    const one = hourlyOf([20], "2026-11-17T14:00");
    expect(heroHourStrip(one, NOW, OFFSET, 20)).toEqual([]);
  });

  it("is shorter, not padded, when fewer than five hours remain", () => {
    const short = hourlyOf([21, 22, 23], "2026-11-17T14:00");
    expect(heroHourStrip(short, NOW, OFFSET).map((h) => h.label)).toEqual([
      "Now",
      "15:00",
      "16:00",
    ]);
  });

  it("stops at the first unreadable hour instead of skipping it", () => {
    const gappy = hourlyOf([21, 22, null, 24, 25], "2026-11-17T14:00");
    const strip = heroHourStrip(gappy, NOW, OFFSET);
    expect(strip.map((h) => h.label)).toEqual(["Now", "15:00"]);
    expect(JSON.stringify(strip)).not.toContain("null");
  });

  it("keeps negative temperatures as they are", () => {
    const cold = hourlyOf([-4.4, -5.1, -6.6, -7, -7.4], "2026-11-17T14:00");
    const strip = heroHourStrip(cold, NOW, OFFSET, -4.4);
    expect(strip.map((h) => formatDegrees(h.temperature))).toEqual([
      "-4°",
      "-5°",
      "-7°",
      "-7°",
      "-7°",
    ]);
  });
});

describe("heroDayCurve", () => {
  const full = () => heroDayCurve(hourlyOf(DAY_TEMPS), NOW, OFFSET, 27.6);

  it("draws 25 points from now: a line, a closed fill, five ticks", () => {
    const curve = full();
    expect(curve).not.toBeNull();
    expect(curve!.linePath.startsWith("M")).toBe(true);
    expect(curve!.linePath.match(/L/g)).toHaveLength(24);
    expect(curve!.areaPath.endsWith("Z")).toBe(true);
    expect(curve!.ticks.map((t) => t.label.text)).toEqual([
      "14:00",
      "20:00",
      "02:00",
      "08:00",
      "14:00",
    ]);
    expect(curve!.ticks[0].x).toBeLessThan(curve!.ticks[4].x);
  });

  it("never holds NaN, undefined or Infinity, whatever the input", () => {
    const inputs: Array<HourlyWeather | undefined> = [
      hourlyOf(DAY_TEMPS),
      hourlyOf(Array.from({ length: 30 }, () => 22)),
      hourlyOf(Array.from({ length: 30 }, (_, i) => -10 - i)),
      hourlyOf([21, 22, 23, 24, 25], "2026-11-17T14:00"),
    ];
    for (const input of inputs) {
      const curve = heroDayCurve(input, NOW, OFFSET, 22);
      const text = JSON.stringify(curve);
      expect(text).not.toMatch(/NaN|undefined|Infinity/);
    }
  });

  it("marks now, with the numeral's temperature, at the left", () => {
    const curve = full()!;
    expect(curve.now.label.text).toBe("28° now");
    expect(curve.now.label.anchor).toBe("start");
    expect(curve.now.x).toBeLessThan(curve.width / 4);
  });

  it("marks the low, later than now and cooler, with its clock", () => {
    // 14:00 today is 27.6 (hero), the curve falls to a low at 00:00 tomorrow
    // (index 24: 20) and the DAY_TEMPS series climbs again from there.
    const curve = heroDayCurve(
      hourlyOf(DAY_TEMPS),
      NOW,
      OFFSET,
      DAY_TEMPS[14],
    )!;
    expect(curve.low).not.toBeNull();
    expect(curve.low!.label!.text).toMatch(/^\d+° at \d\d:00$/);
    expect(curve.low!.x).toBeGreaterThan(curve.now.x);
  });

  it("has no low marker when now is the coolest hour (rising all day)", () => {
    const rising = hourlyOf(
      Array.from({ length: 30 }, (_, i) => 10 + i),
      "2026-11-17T14:00",
    );
    const curve = heroDayCurve(rising, NOW, OFFSET, 10)!;
    expect(curve.low).toBeNull();
    expect(curve.ariaLabel).toContain("rising to");
  });

  it("is a flat line in the middle of the plot when every hour is equal", () => {
    const flat = hourlyOf(
      Array.from({ length: 30 }, () => 21),
      "2026-11-17T14:00",
    );
    const curve = heroDayCurve(flat, NOW, OFFSET, 21)!;
    expect(curve.low).toBeNull();
    const ys = new Set(
      curve.linePath
        .slice(1)
        .split("L")
        .map((p) => p.split(" ")[1]),
    );
    expect(ys.size).toBe(1);
    const y = Number([...ys][0]);
    expect(y).toBeGreaterThan(HERO_CURVE_BOX.top);
    expect(y).toBeLessThan(curve.baseY);
    expect(curve.ariaLabel).toContain("holding at 21 degrees");
  });

  it("handles negative temperatures: labels in degrees, words for a screen reader", () => {
    const cold = hourlyOf(
      [-2, -3, -4, -5, -6, -7, -8, -9, -8, -7, -6, -5, -4, -3, -2],
      "2026-11-17T14:00",
    );
    const curve = heroDayCurve(cold, NOW, OFFSET, -2)!;
    expect(curve.now.label.text).toBe("-2° now");
    expect(curve.low!.label!.text).toBe("-9° at 21:00");
    expect(curve.ariaLabel).toContain("minus 2 degrees now at 14:00");
    expect(curve.ariaLabel).toContain("a low of minus 9 degrees at 21:00");
    expect(curve.ariaLabel).not.toContain("-");
  });

  it("describes the day for a screen reader, with 'tomorrow' once midnight passes", () => {
    const sentence = full()!.ariaLabel;
    expect(sentence).toMatch(
      /^Temperature over the next 24 hours: 28 degrees now at 14:00/,
    );
    expect(sentence).toMatch(/by 14:00 tomorrow\.$/);
    // A low at 21:00 the same evening is not "tomorrow".
    const cold = hourlyOf(
      [-2, -3, -4, -5, -6, -7, -8, -9, -8, -7, -6, -5, -4, -3, -2],
      "2026-11-17T14:00",
    );
    const text = heroDayCurve(cold, NOW, OFFSET, -2)!.ariaLabel;
    expect(text).toContain("at 21:00,");
    expect(text).not.toContain("21:00 tomorrow");
    expect(text).toContain("by 04:00 tomorrow");
  });

  it("draws the hours it has when fewer than 24 remain, with ticks only where data is", () => {
    const ten = hourlyOf(
      [24, 23, 22, 21, 20, 19, 18, 17, 17, 18],
      "2026-11-17T14:00",
    );
    const curve = heroDayCurve(ten, NOW, OFFSET, 24)!;
    expect(curve.linePath.match(/L/g)).toHaveLength(9);
    expect(curve.ticks.map((t) => t.label.text)).toEqual(["14:00", "20:00"]);
    expect(curve.ariaLabel).toContain("over the next 9 hours");
  });

  it("is null for a missing, stale or too-short series, never a broken curve", () => {
    expect(heroDayCurve(undefined, NOW, OFFSET, 20)).toBeNull();
    expect(heroDayCurve(hourlyOf([]), NOW, OFFSET, 20)).toBeNull();
    expect(
      heroDayCurve(hourlyOf(DAY_TEMPS, "2026-11-10T00:00"), NOW, OFFSET, 20),
    ).toBeNull();
    expect(
      heroDayCurve(hourlyOf([20, 21, 22], "2026-11-17T14:00"), NOW, OFFSET),
    ).toBeNull();
    // A gap early in the series leaves too few readable points.
    expect(
      heroDayCurve(
        hourlyOf([20, 21, null, 23, 24, 25], "2026-11-17T14:00"),
        NOW,
        OFFSET,
      ),
    ).toBeNull();
  });

  it("uses the measured width, and the text size's scale for the vertical room", () => {
    const wide = heroDayCurve(hourlyOf(DAY_TEMPS), NOW, OFFSET, 27, {
      width: 600,
    })!;
    expect(wide.width).toBe(600);
    expect(wide.ticks[4].x).toBeCloseTo(600 - HERO_CURVE_BOX.inset, 1);
    const big = heroDayCurve(hourlyOf(DAY_TEMPS), NOW, OFFSET, 27, {
      scale: 2,
    })!;
    expect(big.height).toBe(HERO_CURVE_BOX.height * 2);
    expect(big.width).toBe(HERO_CURVE_DEFAULT_WIDTH);
    const bad = heroDayCurve(hourlyOf(DAY_TEMPS), NOW, OFFSET, 27, {
      width: Number.NaN,
      scale: -1,
    })!;
    expect(bad.width).toBe(HERO_CURVE_DEFAULT_WIDTH);
    expect(bad.height).toBe(HERO_CURVE_BOX.height);
  });

  it("sets the now and low labels above the line everywhere under their text, even where it climbs steeply beside them", () => {
    // Falls to a low, then climbs hard: the line passes beside both labels.
    const steep = hourlyOf(
      [-9, -9, -8, -4, 2, 8, 12, 14, 13, 9, 3, -3, -8, -10, -9, -8],
      "2026-11-17T14:00",
    );
    const curve = heroDayCurve(steep, NOW, OFFSET, -9)!;
    const points = curve.linePath
      .slice(1)
      .split("L")
      .map((pair) => pair.split(" ").map(Number));
    for (const label of [curve.now.label, curve.low!.label!]) {
      const [from, to] = curveLabelSpan(label, 1);
      for (const [x, y] of points) {
        if (x >= from && x <= to) {
          expect(label.y, `${label.text} at x=${x}`).toBeLessThan(y);
        }
      }
      expect(label.y).toBeGreaterThan(0);
    }
  });

  it("never sets the now label and the low label on each other: before dawn, with the low soon after now, the low's label moves right or is left out", () => {
    // 02:00 now, the low three hours on: the two labels would share a line.
    const nowAt2 = new Date(Date.UTC(2026, 10, 17, 0, 10));
    const predawn = hourlyOf(
      [
        15, 14.5, 14, 13.5, 13, 13, 13.1, 13.2, 13.2, 13.2, 13.2, 13.2, 13.2,
        13.2,
      ],
      "2026-11-17T02:00",
    );
    for (const width of [170, 200, 254, 294, 320, 400, 700]) {
      const curve = heroDayCurve(predawn, nowAt2, OFFSET, 15, { width })!;
      expect(curve.low, `width ${width}`).not.toBeNull();
      const low = curve.low!.label;
      if (low) {
        const [a0, a1] = curveLabelSpan(curve.now.label, 1);
        const [b0, b1] = curveLabelSpan(low, 1);
        const sameLine = Math.abs(curve.now.label.y - low.y) < 21;
        expect(sameLine && a0 < b1 && b0 < a1, `width ${width}`).toBe(false);
        expect(b1, `width ${width}`).toBeLessThanOrEqual(width);
      }
      // The sentence names the low whether or not its label is drawn.
      expect(curve.ariaLabel).toContain("a low of 13 degrees");
    }
    // Room enough: the label is drawn, right of the now label.
    const roomy = heroDayCurve(predawn, nowAt2, OFFSET, 15, { width: 700 })!;
    expect(roomy.low!.label).not.toBeNull();
    // No room: left out, the dot stays.
    const tight = heroDayCurve(predawn, nowAt2, OFFSET, 15, { width: 170 })!;
    expect(tight.low!.label).toBeNull();
    expect(tight.low).not.toBeNull();
  });

  it("keeps every point inside the box", () => {
    const curve = full()!;
    for (const pair of curve.linePath.slice(1).split("L")) {
      const [x, y] = pair.split(" ").map(Number);
      expect(x).toBeGreaterThanOrEqual(HERO_CURVE_BOX.inset);
      expect(x).toBeLessThanOrEqual(curve.width - HERO_CURVE_BOX.inset);
      expect(y).toBeGreaterThanOrEqual(HERO_CURVE_BOX.top);
      expect(y).toBeLessThanOrEqual(curve.baseY);
    }
  });
});

describe("curveLabelAnchor", () => {
  it("anchors a label away from the edge it would cross", () => {
    expect(curveLabelAnchor(10, 12, 320, 1)).toBe("start");
    expect(curveLabelAnchor(160, 12, 320, 1)).toBe("middle");
    expect(curveLabelAnchor(315, 12, 320, 1)).toBe("end");
  });

  it("allows for a larger text size", () => {
    expect(curveLabelAnchor(90, 12, 320, 1)).toBe("middle");
    expect(curveLabelAnchor(90, 12, 320, 2)).toBe("start");
  });
});

describe("heroReadings", () => {
  const current = {
    apparent_temperature: 26.6,
    wind_speed_10m: 12.4,
    uv_index: 8.6,
  };

  it("is Feels, Wind and UV, in that order, with the WHO band word", () => {
    const readings = heroReadings(current);
    expect(readings.map((r) => r.key)).toEqual(["feels", "wind", "uv"]);
    expect(readings[0]).toMatchObject({ label: "Feels", value: "27°" });
    expect(readings[1]).toMatchObject({
      label: "Wind",
      value: "12",
      unit: "km/h",
    });
    expect(readings[2]).toMatchObject({
      label: "UV",
      value: "9",
      unit: "Very High",
    });
  });

  it("names the band of the same UV the card prints", () => {
    expect(heroReadings({ uv_index: 0 })[0]).toMatchObject({
      value: "0",
      unit: "Low",
    });
    expect(heroReadings({ uv_index: 4 })[0].unit).toBe("Moderate");
    expect(heroReadings({ uv_index: 6.4 })[0].unit).toBe("High");
    expect(heroReadings({ uv_index: 12 })[0].unit).toBe("Extreme");
  });

  it("prints a cold Feels with its minus sign", () => {
    expect(heroReadings({ apparent_temperature: -3.4 })[0].value).toBe("-3°");
  });

  it("leaves a reading out when its value is missing or not finite", () => {
    expect(
      heroReadings({ ...current, wind_speed_10m: Number.NaN }).map(
        (r) => r.key,
      ),
    ).toEqual(["feels", "uv"]);
    expect(heroReadings({})).toEqual([]);
    expect(
      heroReadings({
        apparent_temperature: undefined,
        wind_speed_10m: Number.POSITIVE_INFINITY,
        uv_index: Number.NaN,
      }),
    ).toEqual([]);
  });

  it("never prints NaN", () => {
    expect(JSON.stringify(heroReadings(current))).not.toContain("NaN");
  });
});
