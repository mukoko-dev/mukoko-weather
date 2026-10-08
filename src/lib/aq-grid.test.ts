import { describe, it, expect, vi, afterEach } from "vitest";
import {
  aqiBand,
  gridToGeoJSON,
  fetchAirQualityGrid,
  AQI_BANDS,
  AQI_BAND_LABELS,
  AQI_BAND_SEVERITY_TOKEN,
} from "./aq-grid";

/** Great-circle distance in km (spherical Earth, R = 6371) — matches backend metric. */
function haversineKm(a: readonly number[], b: readonly number[]): number {
  const r = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

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

  it("maps every band to a severity token (no hardcoded colours)", () => {
    for (const band of AQI_BANDS) {
      expect(AQI_BAND_SEVERITY_TOKEN[band]).toMatch(
        /^--color-severity-(low|moderate|high|severe|extreme)$/,
      );
    }
    expect(AQI_BAND_SEVERITY_TOKEN.good).toBe("--color-severity-low");
    expect(AQI_BAND_SEVERITY_TOKEN.hazardous).toBe("--color-severity-extreme");
  });
});

describe("gridToGeoJSON — square cell geometry", () => {
  const cellKm = 13.333;
  const centre = { lat: 1.35, lon: 103.82, aqi: 90, pm2_5: null };
  const fc = gridToGeoJSON([centre], cellKm);
  const ring = (fc.features[0].geometry as GeoJSON.Polygon).coordinates[0];

  it("returns a FeatureCollection with one Polygon per point", () => {
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry.type).toBe("Polygon");
  });

  it("closes the ring and winds counter-clockwise (RFC 7946)", () => {
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    // Shoelace sign: positive means counter-clockwise in lon/lat space.
    let area2 = 0;
    for (let i = 0; i < 4; i++) {
      area2 += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    expect(area2).toBeGreaterThan(0);
  });

  it("centres each cell on its grid point", () => {
    const lons = ring.slice(0, 4).map((c) => c[0]);
    const lats = ring.slice(0, 4).map((c) => c[1]);
    const midLon = (Math.min(...lons) + Math.max(...lons)) / 2;
    const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    expect(midLon).toBeCloseTo(centre.lon, 9);
    expect(midLat).toBeCloseTo(centre.lat, 9);
  });

  it("makes each side the requested cellKm on the ground (square, not stretched)", () => {
    const [sw, se, ne, nw] = ring;
    const west = haversineKm(sw, nw);
    const east = haversineKm(se, ne);
    const south = haversineKm(sw, se);
    const north = haversineKm(nw, ne);
    for (const side of [west, east, south, north]) {
      expect(side).toBeCloseTo(cellKm, 1);
    }
  });

  it("keeps cells square at high latitude (lon span widens by 1/cos(lat))", () => {
    const hi = gridToGeoJSON(
      [{ lat: 60, lon: 10, aqi: 10, pm2_5: null }],
      cellKm,
    );
    const r = (hi.features[0].geometry as GeoJSON.Polygon).coordinates[0];
    const lonSpan = r[1][0] - r[0][0];
    const latSpan = r[2][1] - r[1][1];
    // At 60°, 1° of longitude is half a degree of arc, so the lon span is ~2× the lat span.
    expect(lonSpan / latSpan).toBeCloseTo(2, 2);
  });

  it("tags each cell with its aqi and EPA band", () => {
    const fc2 = gridToGeoJSON(
      [
        { lat: 0, lon: 0, aqi: 42, pm2_5: null },
        { lat: 0, lon: 1, aqi: 180, pm2_5: null },
      ],
      10,
    );
    expect(fc2.features[0].properties).toEqual({ aqi: 42, band: "good" });
    expect(fc2.features[1].properties).toEqual({ aqi: 180, band: "unhealthy" });
  });

  it("keeps cells with no reading, with a null band", () => {
    const fc3 = gridToGeoJSON([{ lat: 0, lon: 0, aqi: null, pm2_5: null }], 10);
    expect(fc3.features).toHaveLength(1);
    expect(fc3.features[0].properties).toEqual({ aqi: null, band: null });
  });

  it("produces a full 7×7 grid of 49 non-overlapping-centre cells", () => {
    const points = [];
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        points.push({
          lat: 1 + r * 0.1,
          lon: 103 + c * 0.1,
          aqi: 50,
          pm2_5: null,
        });
      }
    }
    expect(gridToGeoJSON(points, 13.333).features).toHaveLength(49);
  });

  it("does not blow up at the pole (cos(lat) guard)", () => {
    const pole = gridToGeoJSON([{ lat: 90, lon: 0, aqi: 1, pm2_5: null }], 10);
    const coords = (pole.features[0].geometry as GeoJSON.Polygon)
      .coordinates[0];
    expect(
      coords.every((c) => Number.isFinite(c[0]) && Number.isFinite(c[1])),
    ).toBe(true);
  });
});

describe("fetchAirQualityGrid", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the grid endpoint with rounded coordinates, radius and n", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
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
    expect(url.startsWith("/api/py/airquality/grid?")).toBe(true);
    const params = new URL(url, "http://x").searchParams;
    expect(params.get("lat")).toBe("1.3512");
    expect(params.get("lon")).toBe("103.8249");
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

  it("forwards the abort signal", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await fetchAirQualityGrid({ lat: 0, lon: 0, signal: controller.signal });
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });
});
