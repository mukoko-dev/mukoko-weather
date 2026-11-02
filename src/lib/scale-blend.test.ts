import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bandCentreStops,
  blendGradientCss,
  evenStops,
  trackWindow,
  valueStops,
} from "./scale-blend";
import {
  AQI_SCALE,
  TEMP_ANCHORS,
  TEMP_BLEND_MAX,
  TEMP_BLEND_MIN,
  TEMP_SCALE,
  UV_SCALE,
  UV_SCALE_MAX,
  WEATHER_SCALES,
  scaleAnchors,
  scaleBandIndex,
} from "./weather-scales";
import { aqiScalePct } from "./air-quality-details";
import { blendStops } from "@/components/weather/widgets/geometry";

const css = readFileSync(join(__dirname, "../app/globals.css"), "utf8");

describe("blend stops", () => {
  it("bandCentreStops puts each colour at the middle of its band", () => {
    expect(bandCentreStops(["a", "b"], [0, 40, 100])).toEqual([
      { color: "a", pct: 20 },
      { color: "b", pct: 70 },
    ]);
  });

  it("evenStops runs first colour at 0 to last at 100, one colour is flat", () => {
    expect(evenStops(["a", "b", "c"]).map((s) => s.pct)).toEqual([0, 50, 100]);
    expect(evenStops(["a"])).toEqual([
      { color: "a", pct: 0 },
      { color: "a", pct: 100 },
    ]);
  });

  it("valueStops maps values to positions and may fall outside the bar", () => {
    const stops = valueStops(
      [
        { token: "--wx-temp-1", value: 0 },
        { token: "--wx-temp-9", value: 40 },
      ],
      (v) => ((v - 10) / 20) * 100,
    );
    expect(stops).toEqual([
      { color: "var(--wx-temp-1)", pct: -50 },
      { color: "var(--wx-temp-9)", pct: 150 },
    ]);
  });

  it("blendGradientCss writes a single linear-gradient", () => {
    expect(
      blendGradientCss([
        { color: "var(--a)", pct: 10 },
        { color: "var(--b)", pct: 90 },
      ]),
    ).toBe("linear-gradient(to right, var(--a) 10%, var(--b) 90%)");
  });
});

describe("trackWindow", () => {
  it("shows the full track through the window, wherever the window sits", () => {
    for (const [a, b] of [
      [0, 100],
      [20, 80],
      [10, 12],
      [90, 100],
      [95, 99],
      [50, 50],
      [80, 20],
    ]) {
      const w = trackWindow(a, b, 4);
      // Inner element, in track coordinates (% of the track).
      const innerLeftInTrack = w.left + (w.innerLeft / 100) * w.width;
      const innerWidthInTrack = (w.innerWidth / 100) * w.width;
      expect(innerLeftInTrack, `${a}..${b}`).toBeCloseTo(0, 1);
      expect(innerWidthInTrack, `${a}..${b}`).toBeCloseTo(100, 1);
      // The window stays on the track.
      expect(w.left).toBeGreaterThanOrEqual(0);
      expect(w.left + w.width).toBeLessThanOrEqual(100.01);
    }
  });

  it("keeps a minimum width and tolerates swapped or non-finite ends", () => {
    expect(trackWindow(50, 50, 4).width).toBe(4);
    expect(trackWindow(80, 20).left).toBe(20);
    expect(trackWindow(Number.NaN, Number.NaN).width).toBe(100);
  });
});

describe("blend agrees with where the markers go", () => {
  it("each AQI colour sits where a mid-band reading puts its marker", () => {
    // The middle value of each EPA band: 0-50, 51-100, 101-150, 151-200,
    // 201-300, 301-500.
    const mids = [25, 75, 125, 175, 250, 400];
    const stops = blendStops("aqi");
    mids.forEach((aqi, i) => {
      expect(stops[i].pct).toBeCloseTo(aqiScalePct(aqi), 1);
      expect(stops[i].color).toBe(`var(${AQI_SCALE.bands[i].token})`);
    });
  });

  it("each UV colour sits where a mid-band reading puts its marker", () => {
    // Bands 0-3, 3-6, 6-8, 8-11, 11-14 on a 0-14 bar.
    const edges = [...UV_SCALE.bands.map((b) => b.from), UV_SCALE_MAX];
    const stops = blendStops("uv");
    stops.forEach((stop, i) => {
      const mid = (edges[i] + edges[i + 1]) / 2;
      expect(stop.pct).toBeCloseTo((mid / UV_SCALE_MAX) * 100, 1);
      expect(stop.color).toBe(`var(${UV_SCALE.bands[i].token})`);
    });
  });
});

describe("scaleAnchors (temperature)", () => {
  it("has one anchor per band, in band order, each inside its own band", () => {
    expect(TEMP_ANCHORS).toHaveLength(TEMP_SCALE.bands.length);
    TEMP_ANCHORS.forEach((anchor, i) => {
      expect(anchor.token).toBe(TEMP_SCALE.bands[i].token);
      expect(scaleBandIndex(TEMP_SCALE, anchor.value)).toBe(i);
      if (i > 0)
        expect(anchor.value).toBeGreaterThan(TEMP_ANCHORS[i - 1].value);
    });
  });

  it("closes the open ends of the scale with the blend domain", () => {
    expect(TEMP_ANCHORS.map((a) => a.value)).toEqual([
      -15, -5, 4, 12, 20, 27, 33, 39, 45,
    ]);
    expect(TEMP_ANCHORS[0].value).toBeGreaterThan(TEMP_BLEND_MIN);
    expect(TEMP_ANCHORS[8].value).toBeLessThan(TEMP_BLEND_MAX);
  });

  it("works for any scale (every anchor lies in its own band)", () => {
    for (const scale of WEATHER_SCALES) {
      const anchors = scaleAnchors(scale, -100, 1000);
      anchors.forEach((a, i) =>
        expect(scaleBandIndex(scale, a.value), scale.id).toBe(i),
      );
    }
  });
});

describe("scale size tokens (a scale is small on every screen)", () => {
  const rootBlock = css.slice(0, css.indexOf('[data-theme="dark"] {'));
  const darkBlock = css.slice(css.indexOf('[data-theme="dark"] {'));
  const rem = (name: string) => {
    const m = rootBlock.match(new RegExp(`${name}:\\s*([\\d.]+)rem;`));
    expect(m, `${name} must be a fixed rem value in :root`).not.toBeNull();
    return Number(m![1]);
  };

  it("defines a fixed track, marker and max width in :root (rem, no %)", () => {
    expect(rem("--wx-scale-track-height")).toBe(0.75); // 12px
    expect(rem("--wx-scale-marker-size")).toBe(1.25); // 20px
    expect(rem("--wx-scale-max-width")).toBe(24); // 384px
  });

  it("keeps the track thin and the marker small, the marker larger than the track", () => {
    expect(rem("--wx-scale-track-height")).toBeLessThanOrEqual(1);
    expect(rem("--wx-scale-marker-size")).toBeLessThanOrEqual(1.5);
    expect(rem("--wx-scale-marker-size")).toBeGreaterThan(
      rem("--wx-scale-track-height"),
    );
  });

  it("is the same in light and dark (not redeclared for dark)", () => {
    expect(darkBlock).not.toContain("--wx-scale-");
  });
});
