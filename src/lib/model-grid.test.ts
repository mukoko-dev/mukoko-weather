import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchModelGrid,
  modelGridToGeoJSON,
  modelLegendTokens,
  type ModelGridResponse,
} from "./model-grid";
import { getMapChip } from "./map-layers";

function grid(overrides: Partial<ModelGridResponse> = {}): ModelGridResponse {
  return {
    available: true,
    model: "ecmwf_ifs",
    cellKm: 40,
    times: ["2026-10-11T07:00Z", "2026-10-11T10:00Z"],
    points: [
      {
        lat: -17.5,
        lon: 31,
        temperature: [8, 24],
        precipitation: [0, 2.5],
        windSpeed: [5, 70],
        windDirection: [90, 180],
      },
      {
        lat: -18,
        lon: 31,
        temperature: [null, 31],
        precipitation: [0.05, null],
        windSpeed: [12, null],
        windDirection: [null, null],
      },
    ],
    fetchedAt: null,
    ...overrides,
  };
}

describe("modelGridToGeoJSON", () => {
  it("colours each cell by the chip legend band for the step", () => {
    const fc = modelGridToGeoJSON(grid(), "modelTemperature", 1)!;
    expect(fc.features).toHaveLength(2);
    // 24 °C → band "24" (index 5); 31 °C → band "30" (index 6).
    expect(fc.features.map((f) => f.properties.band)).toEqual([5, 6]);
    expect(fc.features[0].properties.value).toBe(24);
  });

  it("leaves out nulls and values below the first band", () => {
    const rain = modelGridToGeoJSON(grid(), "modelPrecipitation", 0)!;
    // 0 and 0.05 mm/h are under the 0.1 mm/h first band.
    expect(rain.features).toHaveLength(0);
    const rainLater = modelGridToGeoJSON(grid(), "modelPrecipitation", 1)!;
    expect(rainLater.features).toHaveLength(1);
    const temp = modelGridToGeoJSON(grid(), "modelTemperature", 0)!;
    expect(temp.features).toHaveLength(1);
  });

  it("reads wind speed for the wind chip", () => {
    const fc = modelGridToGeoJSON(grid(), "modelWind", 1)!;
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties.band).toBe(5); // 70 km/h → 62+ (gale)
  });

  it("builds closed square polygons", () => {
    const fc = modelGridToGeoJSON(grid(), "modelTemperature", 1)!;
    const ring = fc.features[0].geometry.coordinates[0];
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
  });

  it("returns null for unavailable grids and non-model layers", () => {
    expect(
      modelGridToGeoJSON(grid({ available: false }), "modelWind", 0),
    ).toBeNull();
    expect(modelGridToGeoJSON(null, "modelWind", 0)).toBeNull();
    expect(modelGridToGeoJSON(grid(), "temperature", 0)).toBeNull();
  });

  it("handles a step beyond the series", () => {
    const fc = modelGridToGeoJSON(grid(), "modelTemperature", 9)!;
    expect(fc.features).toHaveLength(0);
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
