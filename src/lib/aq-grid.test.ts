import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { workerData } from "./worker-data";
import { AQI_SCALE } from "./weather-scales";
import { contourLines, NO_BAND } from "./field-raster";
import {
  aqiBand,
  aqFieldRaster,
  fetchAirQualityGrid,
  AQI_BANDS,
  AQI_BAND_EDGES,
  AQI_BAND_LABELS,
  AQI_BAND_TOKEN,
  AQI_BAND_BG_CLASS,
  aqBubbles,
  type AqGridPoint,
  type AqGridResponse,
} from "./aq-grid";

describe("aqiBand — EPA breakpoints", () => {
  it.each([
    [0, "good"],
    [50, "good"],
    [51, "moderate"],
    [100, "moderate"],
    [101, "usg"],
    [150, "usg"],
    [151, "unhealthy"],
    [200, "unhealthy"],
    [201, "very_unhealthy"],
    [300, "very_unhealthy"],
    [301, "hazardous"],
    [500, "hazardous"],
  ])("AQI %i → %s", (aqi, band) => {
    expect(aqiBand(aqi)).toBe(band);
  });

  it("rounds to the nearest integer before classifying", () => {
    expect(aqiBand(50.4)).toBe("good");
    expect(aqiBand(50.5)).toBe("moderate");
    expect(aqiBand(100.6)).toBe("usg");
  });

  it("orders bands from lowest to highest severity with labels for each", () => {
    expect(AQI_BANDS).toEqual([
      "good",
      "moderate",
      "usg",
      "unhealthy",
      "very_unhealthy",
      "hazardous",
    ]);
    for (const band of AQI_BANDS) {
      expect(AQI_BAND_LABELS[band].length).toBeGreaterThan(0);
    }
  });

  it("maps every band to its own official-EPA weather-scale token", () => {
    AQI_BANDS.forEach((band, i) => {
      expect(AQI_BAND_TOKEN[band]).toBe(`--wx-aqi-${i + 1}`);
    });
    // six bands, six distinct colours (very unhealthy and hazardous no longer share one)
    expect(new Set(Object.values(AQI_BAND_TOKEN)).size).toBe(6);
  });
});

describe("fetchAirQualityGrid", () => {
  beforeEach(() => {
    workerData.reset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the grid endpoint with rounded coordinates, radius and n", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        available: true,
        center: null,
        cellKm: 13.3,
        points: [],
        fetchedAt: null,
        source: "x",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const body = await fetchAirQualityGrid({
      lat: 1.35123,
      lon: 103.8249,
      radiusKm: 40,
      n: 7,
    });

    expect(body.available).toBe(true);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(
      url.startsWith("https://weather-api.mukoko.com/v1/air-quality/grid?"),
    ).toBe(true);
    const params = new URL(url, "http://x").searchParams;
    // Three decimals (~110 m): the app's coordinate privacy rule.
    expect(params.get("lat")).toBe("1.351");
    expect(params.get("lon")).toBe("103.825");
    expect(params.get("radiusKm")).toBe("40");
    expect(params.get("n")).toBe("7");
  });

  it("rejects on a non-2xx response so the caller can degrade", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );
    await expect(fetchAirQualityGrid({ lat: 0, lon: 0 })).rejects.toThrow(
      "HTTP 503",
    );
  });

  it("an abort stops the caller waiting; the shared request is not cancelled", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ points: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const first = fetchAirQualityGrid({
      lat: 0,
      lon: 0,
      signal: controller.signal,
    });
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    // The next mount asks again and reuses the request that is out.
    await fetchAirQualityGrid({ lat: 0, lon: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = fetchMock.mock.calls[0][1].signal as AbortSignal;
    expect(sent.aborted).toBe(false);
  });
});

describe("AQI bubbles (full-screen map)", () => {
  function grid(overrides: Partial<AqGridResponse> = {}): AqGridResponse {
    return {
      available: true,
      center: { lat: -17.8, lon: 31.05, aqi: 142 },
      cellKm: 12,
      points: [
        { lat: -17.8, lon: 31.05, aqi: 142, pm2_5: 40 },
        { lat: -17.7, lon: 31.05, aqi: 42, pm2_5: 8 },
        { lat: -17.9, lon: 31.05, aqi: null, pm2_5: null },
        { lat: -17.8, lon: 31.2, aqi: 310, pm2_5: 150 },
      ],
      fetchedAt: null,
      source: "test",
      ...overrides,
    };
  }

  it("returns [] when the grid is unavailable", () => {
    expect(aqBubbles(grid({ available: false, center: null }))).toEqual([]);
  });

  it("skips grid points with no reading", () => {
    const bubbles = aqBubbles(grid());
    expect(bubbles.some((b) => b.lat === -17.9)).toBe(false);
  });

  it("draws the centre once, as the larger 'my location' bubble", () => {
    const bubbles = aqBubbles(grid());
    const centres = bubbles.filter((b) => b.isCenter);
    expect(centres).toHaveLength(1);
    expect(centres[0]).toMatchObject({ aqi: 142, band: "usg" });
    // The centre's grid point is not drawn a second time.
    expect(
      bubbles.filter((b) => b.lat === -17.8 && b.lon === 31.05),
    ).toHaveLength(1);
  });

  it("classifies and rounds each bubble", () => {
    const bubbles = aqBubbles(grid());
    expect(bubbles.find((b) => b.aqi === 42)).toMatchObject({
      band: "good",
      isCenter: false,
    });
    expect(bubbles.find((b) => b.aqi === 310)).toMatchObject({
      band: "hazardous",
    });
  });

  it("gives every band a static background class from the weather-scale tokens", () => {
    for (const band of AQI_BANDS) {
      expect(AQI_BAND_BG_CLASS[band]).toMatch(/^bg-wx-aqi-[1-6]$/);
    }
    expect(AQI_BAND_BG_CLASS.good).toBe("bg-wx-aqi-1");
    expect(AQI_BAND_BG_CLASS.hazardous).toBe("bg-wx-aqi-6");
  });
});

describe("aqFieldRaster — the grid as one smooth, banded picture", () => {
  const KM_PER_DEG = 111.195;

  /** The Worker's 7 x 7 layout (north-west first), AQI from `f(row, col)`. */
  function aqGrid(
    f: (row: number, col: number) => number | null,
    overrides: Partial<AqGridResponse> = {},
  ): AqGridResponse {
    const points: AqGridPoint[] = [];
    const kmPerDegLon = KM_PER_DEG * Math.cos((-17.83 * Math.PI) / 180);
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 7; col++) {
        const aqi = f(row, col);
        points.push({
          lat: +(-17.83 + ((3 - row) * (40 / 3)) / KM_PER_DEG).toFixed(6),
          lon: +(31.05 + ((col - 3) * (40 / 3)) / kmPerDegLon).toFixed(6),
          aqi,
          pm2_5: aqi === null ? null : aqi / 3,
        });
      }
    }
    return {
      available: true,
      center: { lat: -17.83, lon: 31.05, aqi: points[24].aqi },
      cellKm: 13.333,
      points,
      fetchedAt: null,
      source: "test",
      ...overrides,
    };
  }

  it("returns null when there is nothing to draw", () => {
    expect(aqFieldRaster(null)).toBeNull();
    expect(aqFieldRaster(undefined)).toBeNull();
    expect(aqFieldRaster(aqGrid(() => 50, { available: false }))).toBeNull();
    // A reading for every point missing: nothing to interpolate.
    expect(aqFieldRaster(aqGrid(() => null))).toBeNull();
    // Too few points to be a grid.
    expect(aqFieldRaster(aqGrid(() => 50, { points: [] }))).toBeNull();
  });

  it("classifies every pixel with aqiBand, the rule the bubbles and legend use", () => {
    // A constant field of v shows v's band everywhere, for every integer AQI.
    for (let v = 0; v <= 500; v++) {
      const r = aqFieldRaster(
        aqGrid(() => v),
        { side: 8 },
      )!;
      const expected = AQI_BANDS.indexOf(aqiBand(v));
      expect(new Set(r.bands), `AQI ${v}`).toEqual(new Set([expected]));
    }
  });

  it("paints with the six official EPA band tokens, in band order", () => {
    const r = aqFieldRaster(
      aqGrid(() => 80),
      { side: 8 },
    )!;
    expect(r.tokens).toEqual(AQI_BANDS.map((b) => AQI_BAND_TOKEN[b]));
    expect(r.tokens).toEqual([1, 2, 3, 4, 5, 6].map((n) => `--wx-aqi-${n}`));
  });

  it("outlines the bands at the continuous values where aqiBand changes", () => {
    expect(AQI_BAND_EDGES).toEqual([50.5, 100.5, 150.5, 200.5, 300.5]);
    expect(AQI_BAND_EDGES).toEqual(
      AQI_SCALE.bands.slice(1).map((b) => b.from - 0.5),
    );
    // Either side of every edge aqiBand really does change band (and 50.5 rounds up).
    AQI_BAND_EDGES.forEach((edge, i) => {
      expect(AQI_BANDS.indexOf(aqiBand(edge - 0.001))).toBe(i);
      expect(AQI_BANDS.indexOf(aqiBand(edge))).toBe(i + 1);
    });
    const r = aqFieldRaster(
      aqGrid((_, c) => 20 + c * 30),
      { side: 64 },
    )!;
    expect(r.levels).toEqual(AQI_BAND_EDGES);
    expect(contourLines(r).features.length).toBeGreaterThan(0);
  });

  it("shows the bands BETWEEN two samples that the square cells hid", () => {
    // Good (30) beside unhealthy (170): the old squares drew two blocks and one
    // edge; the smooth field passes through moderate and unhealthy-for-sensitive
    // on the way, and the picture shows them.
    const r = aqFieldRaster(
      aqGrid((_, c) => (c < 3 ? 30 : c > 3 ? 170 : 100)),
      {
        side: 96,
      },
    )!;
    const row = Math.floor(r.height / 2);
    const seen: number[] = [];
    for (let x = 0; x < r.width; x++) {
      const b = r.bands[row * r.width + x];
      if (b !== NO_BAND && seen[seen.length - 1] !== b) seen.push(b);
    }
    // good -> moderate -> usg -> unhealthy, in order, no band skipped.
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it("never invents a band the data did not reach (no overshoot)", () => {
    // A single hot spike in clean air: nothing hotter than the spike appears.
    const r = aqFieldRaster(
      aqGrid((row, col) => (row === 3 && col === 3 ? 160 : 20)),
      {
        side: 96,
      },
    )!;
    const bands = new Set(r.bands);
    expect([...bands].sort()).toEqual([0, 1, 2, 3]); // good .. unhealthy (160), never very unhealthy
    for (const v of r.values) {
      if (!Number.isNaN(v)) {
        expect(v).toBeLessThanOrEqual(160 + 1e-6);
        expect(v).toBeGreaterThanOrEqual(20 - 1e-6);
      }
    }
  });

  it("leaves a hole at a missing reading and never paints it as zero (good)", () => {
    const r = aqFieldRaster(
      aqGrid((row, col) => (row === 3 && col === 4 ? null : 140)),
      {
        side: 96,
      },
    )!;
    expect(r.bands.some((b) => b === NO_BAND)).toBe(true);
    // Nothing near it dropped to the 'good' band: the missing reading does not pull it to 0.
    expect(r.bands.some((b) => b === 0)).toBe(false);
    expect(new Set([...r.bands].filter((b) => b !== NO_BAND))).toEqual(
      new Set([2]),
    );
  });

  it("keeps the raster bounded", () => {
    const r = aqFieldRaster(aqGrid((row, col) => row * col))!;
    expect(r.width).toBeLessThanOrEqual(128);
    expect(r.height).toBeLessThanOrEqual(128);
  });
});
