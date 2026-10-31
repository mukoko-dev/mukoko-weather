import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AQI_SCALE,
  UV_SCALE,
  WEATHER_SCALES,
  WX_SERIES,
  aqiScaleBand,
  scaleBandIndex,
  uvBand,
} from "./weather-scales";
import { legendBandIndex, MAP_CHIPS, MODEL_CHIPS } from "./map-layers";
import { aqiBand, AQI_BANDS } from "./aq-grid";
import { uvLevel } from "./weather";

const css = readFileSync(join(__dirname, "../app/globals.css"), "utf8");
const darkStart = css.indexOf('[data-theme="dark"] {');
const rootBlock = css.slice(0, darkStart);
const darkBlock = css.slice(darkStart, css.indexOf("@theme inline", darkStart));

function hexOf(block: string, token: string): string | null {
  const m = block.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6});`));
  return m ? m[1].toLowerCase() : null;
}
function lum(h: string) {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a: string, b: string) {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe("weather scales", () => {
  it("has strictly ascending breakpoints in every scale", () => {
    for (const scale of WEATHER_SCALES) {
      scale.bands.forEach((band, i) => {
        if (i > 0) expect(band.from).toBeGreaterThan(scale.bands[i - 1].from);
      });
    }
  });

  it("defines every band token in globals.css, light AND dark, and registers it in @theme", () => {
    for (const scale of WEATHER_SCALES) {
      for (const band of scale.bands) {
        expect(hexOf(rootBlock, band.token), band.token).not.toBeNull();
        expect(hexOf(darkBlock, band.token), band.token).not.toBeNull();
        expect(css).toContain(
          `--color-${band.token.slice(2)}: var(${band.token});`,
        );
      }
    }
    for (const name of Object.values(WX_SERIES)) {
      const token = name.slice(4, -1);
      expect(hexOf(rootBlock, token), token).not.toBeNull();
      expect(hexOf(darkBlock, token), token).not.toBeNull();
    }
  });

  it("uses static Tailwind classes that match each band's token", () => {
    for (const scale of WEATHER_SCALES) {
      for (const band of scale.bands) {
        const name = band.token.slice(2);
        expect(band.bg).toBe(`bg-${name}`);
        expect(band.stroke).toBe(`stroke-${name}`);
        expect(band.border).toBe(`border-${name}`);
      }
    }
  });

  it("prints a label and a name for every band (colour is never the only signal)", () => {
    for (const scale of WEATHER_SCALES) {
      for (const band of scale.bands) {
        expect(band.label.length).toBeGreaterThan(0);
        expect(band.name.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps text on every fill at 4.5:1 or better", () => {
    for (const scale of WEATHER_SCALES) {
      for (const band of scale.bands) {
        const fill = hexOf(rootBlock, band.token)!;
        const fg = band.on === "text-wx-fg-dark" ? "#0a0a0a" : "#ffffff";
        expect(
          contrast(fill, fg),
          `${band.token} ${band.on}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps chart series legible on the card in both themes (3:1)", () => {
    for (const name of Object.values(WX_SERIES)) {
      const token = name.slice(4, -1);
      expect(
        contrast(hexOf(rootBlock, token)!, "#ffffff"),
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrast(hexOf(darkBlock, token)!, "#1e1e1c"),
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("uses the official US EPA AQI colours and ceilings", () => {
    const hex = AQI_SCALE.bands.map((b) => hexOf(rootBlock, b.token));
    expect(hex).toEqual([
      "#00e400",
      "#ffff00",
      "#ff7e00",
      "#ff0000",
      "#8f3f97",
      "#7e0023",
    ]);
    expect(AQI_SCALE.bands.map((b) => b.from)).toEqual([
      0, 51, 101, 151, 201, 301,
    ]);
  });

  it("uses the WHO UV categories and hues", () => {
    expect(UV_SCALE.bands.map((b) => b.from)).toEqual([0, 3, 6, 8, 11]);
    expect(UV_SCALE.bands.map((b) => b.name)).toEqual([
      "Low",
      "Moderate",
      "High",
      "Very high",
      "Extreme",
    ]);
    expect(hexOf(rootBlock, "--wx-uv-2")).toBe("#f7e400");
    expect(hexOf(rootBlock, "--wx-uv-3")).toBe("#f85900");
  });

  it("marks which scales are standards and which are ours", () => {
    const status = Object.fromEntries(
      WEATHER_SCALES.map((s) => [s.id, s.status]),
    );
    expect(status.aqi).toBe("published");
    expect(status.uv).toBe("published");
    expect(status.cloud).toBe("ours");
    expect(status.frost).toBe("ours");
  });

  it("temperature runs blue to red and rain follows the NOAA rate table", () => {
    const temp = WEATHER_SCALES.find((s) => s.id === "temp")!;
    const first = hexOf(rootBlock, temp.bands[0].token)!;
    const last = hexOf(rootBlock, temp.bands.at(-1)!.token)!;
    expect(parseInt(first.slice(5, 7), 16)).toBeGreaterThan(
      parseInt(first.slice(1, 3), 16),
    );
    expect(parseInt(last.slice(1, 3), 16)).toBeGreaterThan(
      parseInt(last.slice(5, 7), 16),
    );
    const rain = WEATHER_SCALES.find((s) => s.id === "rain")!;
    expect(rain.bands.map((b) => b.from)).toEqual([
      0.1, 1, 3, 6, 12, 24, 47, 100,
    ]);
  });

  it("wind breakpoints sit on Beaufort boundaries (km/h)", () => {
    const wind = WEATHER_SCALES.find((s) => s.id === "wind")!;
    const beaufortKmh = [0, 1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
    for (const band of wind.bands) expect(beaufortKmh).toContain(band.from);
  });

  it("band lookup agrees with legendBandIndex and the AQI / UV helpers", () => {
    let checked = 0;
    for (const chip of [...MAP_CHIPS, ...MODEL_CHIPS]) {
      if (chip.legend.segments.length === 0) continue;
      const scale = WEATHER_SCALES.find((s) =>
        chip.legend.segments.every((seg) =>
          seg.className.startsWith(`bg-wx-${s.id}-`),
        ),
      );
      expect(scale, chip.id).toBeDefined();
      expect(chip.legend.segments.map((s) => s.label)).toEqual(
        scale!.bands.map((b) => b.label),
      );
      if (chip.legend.segments[0].from !== undefined) {
        for (const v of [-20, -5, 0.05, 0.1, 5, 17, 33, 45, 70, 120]) {
          expect(legendBandIndex(chip.legend, v)).toBe(
            scaleBandIndex(scale!, v),
          );
        }
        checked++;
      }
    }
    expect(checked).toBe(MODEL_CHIPS.length);
    AQI_BANDS.forEach((band, i) => {
      for (const v of [
        0, 50, 51, 100, 101, 150, 151, 200, 201, 300, 301, 480,
      ]) {
        if (aqiBand(v) === band)
          expect(aqiScaleBand(v)).toBe(AQI_SCALE.bands[i]);
      }
    });
    for (const v of [0, 2, 2.4, 2.6, 5, 7, 10, 11, 14]) {
      expect(uvLevel(v).swatch).toBe(uvBand(v)!.bg);
    }
  });
});

describe("no brand mineral in a weather data encoding", () => {
  it("keeps minerals and severity tokens out of legends, fills and styles", () => {
    for (const f of [
      "aq-grid.ts",
      "model-grid.ts",
      "flight-category-styles.ts",
      "frost-styles.ts",
    ]) {
      const src = readFileSync(join(__dirname, f), "utf8");
      expect(src, f).not.toMatch(/mineral-|severity-/);
    }
    // The layer TOGGLE buttons (MAP_LAYERS styles) are UI chrome and keep minerals;
    // everything from the legends down is data.
    const layers = readFileSync(join(__dirname, "map-layers.ts"), "utf8");
    const legends = layers.slice(layers.indexOf("export const AQI_LEGEND"));
    expect(legends).not.toMatch(/mineral-|severity-/);
  });

  it("keeps minerals out of the chart series that encode measured values", () => {
    const dir = join(__dirname, "../components/weather");
    const files = [
      "HourlyChart.tsx",
      "DailyChart.tsx",
      ...[
        "TemperatureTrendChart",
        "PrecipitationChart",
        "WindSpeedChart",
        "HumidityChart",
        "HumidityCloudChart",
        "UVIndexChart",
        "UVCloudChart",
        "PressureChart",
        "DewPointChart",
        "FeelsLikeChart",
        "MonthlyNormalsChart",
        "VisibilityChart",
        "ThunderstormChart",
        "HeatStressChart",
      ].map((n) => `charts/${n}.tsx`),
    ];
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/var\(--chart-\d\)|mineral-|severity-/);
    }
  });
});
