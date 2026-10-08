import { describe, it, expect } from "vitest";
import {
  arcPoint,
  barHeights,
  clampPct,
  compassPoint,
  compassTicks,
  fractionOf,
  gradientTokens,
  illuminationFromPhase,
  moonTerminatorGeometry,
  moonTerminatorPath,
  polar,
  sunArcPath,
  sunArcPoint,
  sunArcSegmentPath,
  trendGlyph,
  windAriaLabel,
} from "./geometry";

describe("polar / arcPoint", () => {
  it("0° is the top, 90° is the right, clockwise", () => {
    expect(polar(50, 50, 10, 0)).toEqual({ x: 50, y: 40 });
    expect(polar(50, 50, 10, 90)).toEqual({ x: 60, y: 50 });
    expect(polar(50, 50, 10, 180)).toEqual({ x: 50, y: 60 });
  });

  it("arcPoint runs left→over-the-top→right on the upper semicircle", () => {
    expect(arcPoint(60, 60, 40, 0)).toEqual({ x: 20, y: 60 });
    expect(arcPoint(60, 60, 40, 0.5)).toEqual({ x: 60, y: 20 });
    expect(arcPoint(60, 60, 40, 1)).toEqual({ x: 100, y: 60 });
  });
});

describe("compass helpers", () => {
  it("maps bearings to 16-point labels", () => {
    expect(compassPoint(0)).toBe("N");
    expect(compassPoint(70)).toBe("ENE");
    expect(compassPoint(350)).toBe("N");
    expect(compassPoint(-90)).toBe("W");
    expect(compassPoint(180)).toBe("S");
  });

  it("builds the wind aria sentence, with optional gust", () => {
    expect(windAriaLabel(70, 5)).toBe("Wind 5 km/h from the ENE");
    expect(windAriaLabel(0, 12, "mph", 20)).toBe(
      "Wind 12 mph from the N, gusts 20 mph",
    );
  });

  it("ticks every 10° with a major tick every 30°", () => {
    const ticks = compassTicks(50, 50, 40, 10, 30);
    expect(ticks).toHaveLength(36);
    expect(ticks.filter((t) => t.major)).toHaveLength(12);
  });
});

describe("moonTerminatorPath", () => {
  it("new moon lights nothing", () => {
    expect(moonTerminatorPath(0, 40)).toBe("");
  });

  it("full moon lights the whole disc with two half-arcs", () => {
    const d = moonTerminatorPath(0.5, 40);
    expect(d).toBe("M 0 -40 A 40 40 0 1 1 0 40 A 40 40 0 1 1 0 -40 Z");
  });

  it("first quarter is lit on the right: outer arc sweeps right, terminator is a straight line", () => {
    const d = moonTerminatorPath(0.25, 40);
    expect(d.startsWith("M 0 -40 A 40 40 0 0 1 0 40")).toBe(true);
    expect(moonTerminatorGeometry(0.25, 40).rx).toBe(0);
  });

  it("last quarter is lit on the left: outer arc sweeps left", () => {
    const d = moonTerminatorPath(0.75, 40);
    expect(d.startsWith("M 0 -40 A 40 40 0 0 0 0 40")).toBe(true);
  });

  it("waxing crescent: terminator semi-axis is |cos| of the phase and bulges right (sweep 0)", () => {
    const g = moonTerminatorGeometry(0.1, 40);
    expect(g.waxing).toBe(true);
    expect(g.crescent).toBe(true);
    expect(g.rx).toBeCloseTo(40 * Math.cos(2 * Math.PI * 0.1), 2);
    expect(moonTerminatorPath(0.1, 40)).toMatch(/A 32\.361 40 0 0 0 0 -40 Z$/);
  });

  it("waxing gibbous: terminator bulges left (sweep 1)", () => {
    expect(moonTerminatorPath(0.4, 40)).toMatch(/A 32\.361 40 0 0 1 0 -40 Z$/);
  });

  it("waning crescent mirrors the waxing crescent onto the left", () => {
    const d = moonTerminatorPath(0.9, 40);
    expect(d.startsWith("M 0 -40 A 40 40 0 0 0 0 40")).toBe(true);
    expect(d).toMatch(/A 32\.361 40 0 0 1 0 -40 Z$/);
  });

  it("wraps phases outside 0–1", () => {
    expect(moonTerminatorPath(1.25, 40)).toBe(moonTerminatorPath(0.25, 40));
  });
});

describe("illuminationFromPhase", () => {
  it("is 0 at new, 0.5 at quarter, 1 at full", () => {
    expect(illuminationFromPhase(0)).toBe(0);
    expect(illuminationFromPhase(0.25)).toBe(0.5);
    expect(illuminationFromPhase(0.5)).toBe(1);
  });
});

describe("sun arc", () => {
  it("starts and ends on the horizon", () => {
    expect(sunArcPoint(200, 80, 0)).toEqual({ x: 0, y: 80 });
    expect(sunArcPoint(200, 80, 1)).toEqual({ x: 200, y: 80 });
    expect(sunArcPath(200, 80)).toBe("M 0 80 Q 100 -48 200 80");
  });

  it("peaks at the middle, inside the viewBox", () => {
    const mid = sunArcPoint(200, 80, 0.5);
    expect(mid.x).toBe(100);
    expect(mid.y).toBe(16);
  });

  it("travelled segment ends on the arc point at t", () => {
    const seg = sunArcSegmentPath(200, 80, 0.5);
    const end = sunArcPoint(200, 80, 0.5);
    expect(seg.endsWith(`${end.x} ${end.y}`)).toBe(true);
    expect(seg.startsWith("M 0 80 Q ")).toBe(true);
  });

  it("clamps t", () => {
    expect(sunArcPoint(200, 80, 3)).toEqual(sunArcPoint(200, 80, 1));
  });
});

describe("value helpers", () => {
  it("clampPct bounds and guards NaN", () => {
    expect(clampPct(-5)).toBe(0);
    expect(clampPct(150)).toBe(100);
    expect(clampPct(42)).toBe(42);
    expect(clampPct(Number.NaN)).toBe(0);
  });

  it("fractionOf clamps to 0–1", () => {
    expect(fractionOf(1013, 960, 1050)).toBeCloseTo(53 / 90, 6);
    expect(fractionOf(900, 960, 1050)).toBe(0);
    expect(fractionOf(2000, 960, 1050)).toBe(1);
  });

  it("gradientTokens resolves presets and filters unsafe names", () => {
    expect(gradientTokens("uv")).toHaveLength(5);
    expect(gradientTokens("aqi")[0]).toBe("var(--color-severity-low)");
    expect(
      gradientTokens(["--color-severity-low", "url(evil)", "--mineral-gold"]),
    ).toEqual(["var(--color-severity-low)", "var(--mineral-gold)"]);
    expect(gradientTokens([])).toEqual(["var(--color-severity-low)"]);
  });

  it("barHeights scales to the max (or series max)", () => {
    expect(barHeights([1, 2, 4])).toEqual([25, 50, 100]);
    expect(barHeights([1, 2, 4], 8)).toEqual([12.5, 25, 50]);
    expect(barHeights([Number.NaN, -3])).toEqual([0, 0]);
  });

  it("trendGlyph maps the three trends", () => {
    expect(trendGlyph("rising")).toBe("↑");
    expect(trendGlyph("falling")).toBe("↓");
    expect(trendGlyph("steady")).toBe("→");
  });
});
