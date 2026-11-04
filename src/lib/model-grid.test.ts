import { describe, it, expect, vi, afterEach } from "vitest";
import { NO_BAND, contourLines } from "./field-raster";
import {
  fetchModelGrid,
  modelFieldRaster,
  modelLegendTokens,
  type ModelGridPoint,
  type ModelGridResponse,
} from "./model-grid";
import { getMapChip, legendBandIndex } from "./map-layers";

const KM_PER_DEG = 111.195;

type Field = (row: number, col: number, step: number) => number | null;

/**
 * The Worker's 7 x 7 layout (north-west first, 40 km apart), two timeline
 * steps. Each variable is read from the `fields` given, else a constant.
 */
function grid(
  fields: {
    temperature?: Field;
    precipitation?: Field;
    windSpeed?: Field;
  } = {},
  overrides: Partial<ModelGridResponse> = {},
): ModelGridResponse {
  const kmPerDegLon = KM_PER_DEG * Math.cos((-17.5 * Math.PI) / 180);
  const series = (
    f: Field | undefined,
    fallback: number,
    row: number,
    col: number,
  ) => [0, 1].map((step) => (f ? f(row, col, step) : fallback));
  const points: ModelGridPoint[] = [];
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 7; col++) {
      points.push({
        lat: +(-17.5 + ((3 - row) * 40) / KM_PER_DEG).toFixed(6),
        lon: +(31 + ((col - 3) * 40) / kmPerDegLon).toFixed(6),
        temperature: series(fields.temperature, 20, row, col),
        precipitation: series(fields.precipitation, 0, row, col),
        windSpeed: series(fields.windSpeed, 10, row, col),
        windDirection: [90, 180],
      });
    }
  }
  return {
    available: true,
    model: "ecmwf_ifs",
    cellKm: 40,
    times: ["2026-10-11T07:00Z", "2026-10-11T10:00Z"],
    points,
    fetchedAt: null,
    ...overrides,
  };
}

describe("modelFieldRaster — a model field as one smooth, banded picture", () => {
  it("uses the legend's own band rule for every pixel of a constant field", () => {
    const legend = getMapChip("modelTemperature")!.legend;
    for (const t of [
      -25, -10, -3, 0, 7.9, 8, 15.9, 16, 24, 30, 36, 41.9, 42, 55,
    ]) {
      const r = modelFieldRaster(
        grid({ temperature: () => t }),
        "modelTemperature",
        0,
        { side: 8 },
      )!;
      expect(new Set(r.bands), `${t} °C`).toEqual(
        new Set([legendBandIndex(legend, t)]),
      );
    }
  });

  it("agrees with the legend about what NO_BAND means", () => {
    expect(NO_BAND).toBe(-1);
    const legend = getMapChip("modelPrecipitation")!.legend;
    expect(legendBandIndex(legend, 0.05)).toBe(NO_BAND);
  });

  it("paints with the chip's tokens and outlines the chip's band starts", () => {
    const r = modelFieldRaster(
      grid({ temperature: (_, c) => 10 + 4 * c }),
      "modelTemperature",
      0,
    )!;
    const legend = getMapChip("modelTemperature")!.legend;
    expect(r.tokens).toEqual(modelLegendTokens(legend));
    expect(r.levels).toEqual(
      legend.segments.map((s) => s.from).filter((f) => Number.isFinite(f)),
    );
    // The first band starts at -Infinity: that is not a contour level.
    expect(r.levels.every((l) => Number.isFinite(l))).toBe(true);
    const lines = contourLines(r);
    expect(lines.features.length).toBeGreaterThan(0);
    // Only the levels the field really crosses (10 .. 34 °C) get a line.
    for (const f of lines.features) {
      expect(f.properties.level).toBeGreaterThan(10);
      expect(f.properties.level).toBeLessThan(34);
    }
  });

  it("reads the series for the step asked", () => {
    const g = grid({ temperature: (_r, _c, step) => (step === 0 ? 8 : 31) });
    const first = modelFieldRaster(g, "modelTemperature", 0, { side: 8 })!;
    const second = modelFieldRaster(g, "modelTemperature", 1, { side: 8 })!;
    // 8 °C is the "8" band (index 3); 31 °C is the "30" band (index 6).
    expect(new Set(first.bands)).toEqual(new Set([3]));
    expect(new Set(second.bands)).toEqual(new Set([6]));
  });

  it("leaves values below the first band clear, but not as holes", () => {
    // Drizzle under 0.1 mm/h: nothing to colour, yet the field is known there.
    const r = modelFieldRaster(
      grid({ precipitation: () => 0.05 }),
      "modelPrecipitation",
      0,
      { side: 8 },
    )!;
    expect(new Set(r.bands)).toEqual(new Set([NO_BAND]));
    expect(r.values.every((v) => !Number.isNaN(v))).toBe(true);
    const rain = modelFieldRaster(
      grid({ precipitation: (_, c) => (c >= 3 ? 2.5 : 0) }),
      "modelPrecipitation",
      0,
    )!;
    expect(rain.bands.some((b) => b === NO_BAND)).toBe(true);
    expect(rain.bands.some((b) => b >= 0)).toBe(true);
  });

  it("outlines where rain starts: the first band's lower bound is a level", () => {
    const rain = modelFieldRaster(
      grid({ precipitation: (_, c) => (c >= 3 ? 2.5 : 0) }),
      "modelPrecipitation",
      0,
    )!;
    expect(rain.levels[0]).toBe(0.1);
    const lines = contourLines(rain);
    expect(lines.features.map((f) => f.properties.level)).toContain(0.1);
  });

  it("leaves a hole where a reading is missing, never a band", () => {
    const r = modelFieldRaster(
      grid({ temperature: (row, col) => (row === 3 && col === 3 ? null : 20) }),
      "modelTemperature",
      0,
    )!;
    const holes = [...r.values].filter(Number.isNaN).length;
    expect(holes).toBeGreaterThan(0);
    expect(holes).toBeLessThan((r.width * r.height) / 10);
    // Holes are NO_BAND, and nothing around them was dragged toward 0 °C.
    expect(
      r.bands.every(
        (b) =>
          b === NO_BAND ||
          b === legendBandIndex(getMapChip("modelTemperature")!.legend, 20),
      ),
    ).toBe(true);
  });

  it("reads wind speed for the wind chip", () => {
    const r = modelFieldRaster(grid({ windSpeed: () => 70 }), "modelWind", 0, {
      side: 8,
    })!;
    expect(new Set(r.bands)).toEqual(
      new Set([legendBandIndex(getMapChip("modelWind")!.legend, 70)]),
    ); // 70 km/h: 62+ (gale)
    expect(r.bands[0]).toBe(5);
  });

  it("returns null when there is nothing to draw", () => {
    expect(
      modelFieldRaster(grid({}, { available: false }), "modelWind", 0),
    ).toBeNull();
    expect(modelFieldRaster(null, "modelWind", 0)).toBeNull();
    expect(modelFieldRaster(undefined, "modelWind", 0)).toBeNull();
    // Not a model layer.
    expect(modelFieldRaster(grid(), "temperature", 0)).toBeNull();
    // A step beyond the series: no readings.
    expect(modelFieldRaster(grid(), "modelTemperature", 9)).toBeNull();
    // Every reading missing at this step.
    expect(
      modelFieldRaster(
        grid({ temperature: () => null }),
        "modelTemperature",
        0,
      ),
    ).toBeNull();
  });

  it("fades the box's edge instead of leaving a hard rectangle", () => {
    const r = modelFieldRaster(grid(), "modelTemperature", 0)!;
    expect(r.alpha[0]).toBeLessThan(8);
    expect(
      r.alpha[Math.floor(r.height / 2) * r.width + Math.floor(r.width / 2)],
    ).toBe(255);
  });

  it("is bounded in size", () => {
    const r = modelFieldRaster(grid(), "modelTemperature", 0)!;
    expect(r.width).toBeLessThanOrEqual(128);
    expect(r.height).toBeLessThanOrEqual(128);
  });
});

describe("modelLegendTokens", () => {
  it("returns one CSS custom property per legend band", () => {
    const legend = getMapChip("modelTemperature")!.legend;
    const tokens = modelLegendTokens(legend);
    expect(tokens).toHaveLength(legend.segments.length);
    for (const t of tokens) expect(t).toMatch(/^--wx-/);
  });

  it("is empty without a legend", () => {
    expect(modelLegendTokens(undefined)).toEqual([]);
  });
});

describe("fetchModelGrid", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls the backend with rounded coordinates and the model", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => grid(),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchModelGrid({
      lat: -17.82917,
      lon: 31.05222,
      model: "gfs_seamless",
    });
    expect(out.available).toBe(true);
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toBe(
      "https://weather-api.mukoko.com/v1/model-grid?lat=-17.8292&lon=31.0522&model=gfs_seamless",
    );
  });

  it("rejects on HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 })),
    );
    await expect(
      fetchModelGrid({ lat: 0, lon: 0, model: "ecmwf_ifs" }),
    ).rejects.toThrow("500");
  });
});
