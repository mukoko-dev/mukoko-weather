import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  AQI_SCALE,
  FLIGHT_CATEGORY_PDF,
  FLIGHT_SCALE,
  PSI_SCALE,
  UV_SCALE,
  WEATHER_SCALES,
  WIND_SCALE,
  WX_SERIES,
  aqiScaleBand,
  scaleBandIndex,
  uvBand,
} from "./weather-scales";
import { legendBandIndex, MAP_CHIPS, MODEL_CHIPS } from "./map-layers";
import { aqiBand, AQI_BANDS } from "./aq-grid";
import { uvLevel } from "./weather";
import { contrastRatio } from "./contrast";

const SRC = join(__dirname, "..");
const css = readFileSync(join(SRC, "app/globals.css"), "utf8");
const darkStart = css.indexOf('[data-theme="dark"] {');
const rootBlock = css.slice(0, darkStart);
const darkBlock = css.slice(darkStart, css.indexOf("@theme inline", darkStart));
const BLOCKS = { light: rootBlock, dark: darkBlock } as const;

/** Card surfaces (mzizi-tokens.css --mzizi-card). */
const CARD = { light: "#ffffff", dark: "#100f0e" } as const;
/**
 * Approximate MapTiler streets-v2 / streets-v2-dark base-map colours (land,
 * plus a lighter and a darker feature colour). ASSUMED, not measured: the
 * style needs a MapTiler key the test cannot use. The outline must hold 3:1
 * against all of them.
 */
const MAP_BASE = {
  light: ["#f2efe9", "#ffffff", "#d4d4d4"],
  dark: ["#1b1b1b", "#2a2a2a", "#3a3a3a"],
} as const;
const THEMES = ["light", "dark"] as const;

function hexOf(block: string, token: string): string | null {
  const m = block.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6});`));
  return m ? m[1].toLowerCase() : null;
}
const tokenHex = (theme: (typeof THEMES)[number], token: string) =>
  hexOf(BLOCKS[theme], token)!;

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
    for (const name of [...Object.values(WX_SERIES), "var(--wx-outline)"]) {
      const token = name.slice(4, -1);
      expect(hexOf(rootBlock, token), token).not.toBeNull();
      expect(hexOf(darkBlock, token), token).not.toBeNull();
    }
    expect(css).toContain("--color-wx-outline: var(--wx-outline);");
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

  it("names Beaufort 8-9 as one gale band (62-88 km/h)", () => {
    const gale = WIND_SCALE.bands.find((b) => b.from === 62)!;
    expect(gale.name).toBe("Gale (8-9)");
  });

  it("keeps text on every fill at 4.5:1 or better (frost is border and tint only)", () => {
    for (const scale of WEATHER_SCALES) {
      if (scale.id === "frost") continue;
      for (const band of scale.bands) {
        const fill = hexOf(rootBlock, band.token)!;
        const fg = band.on === "text-wx-fg-dark" ? "#0a0a0a" : "#ffffff";
        expect(
          contrastRatio(fill, fg),
          `${band.token} ${band.on}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps chart series legible on the card in both themes (3:1)", () => {
    for (const theme of THEMES) {
      for (const name of Object.values(WX_SERIES)) {
        const token = name.slice(4, -1);
        expect(
          contrastRatio(tokenHex(theme, token), CARD[theme]),
          `${theme} ${token}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("gives every series a distinct colour in each theme", () => {
    for (const theme of THEMES) {
      const hexes = Object.values(WX_SERIES).map((n) =>
        tokenHex(theme, n.slice(4, -1)),
      );
      expect(new Set(hexes).size).toBe(hexes.length);
    }
  });

  it("the outline holds 3:1 on the card and on the assumed base map, in both themes", () => {
    for (const theme of THEMES) {
      const outline = tokenHex(theme, "--wx-outline");
      for (const base of [CARD[theme], ...MAP_BASE[theme]]) {
        expect(
          contrastRatio(outline, base),
          `${theme} outline on ${base}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("every data fill is outlined where its own contrast is under 3:1 (all of them are)", () => {
    // The official EPA / WHO / radar fills cannot all reach 3:1 on a light or
    // dark base; the outline is what carries non-text contrast (WCAG 1.4.11).
    const weak: string[] = [];
    for (const theme of THEMES) {
      for (const scale of WEATHER_SCALES) {
        for (const band of scale.bands) {
          const fill = tokenHex(theme, band.token);
          const worst = Math.min(
            ...[CARD[theme], ...MAP_BASE[theme]].map((b) =>
              contrastRatio(fill, b),
            ),
          );
          if (worst < 3) weak.push(`${theme}:${band.token}`);
        }
      }
    }
    // The known-weak set exists (so the outline is necessary) ...
    expect(weak).toContain("dark:--wx-aqi-6");
    expect(weak).toContain("light:--wx-aqi-2");
    // ... and the outline passes in both themes (previous test), and the map
    // and legend swatches draw it.
    const mapSrc = readFileSync(
      join(SRC, "components/weather/map/MapLibreMap.tsx"),
      "utf8",
    );
    expect(mapSrc).toContain("addCellOutline(map, AQI_OVERLAY_ID, beforeId)");
    expect(mapSrc).toContain("addCellOutline(map, MODEL_OVERLAY_ID, beforeId)");
    expect(mapSrc).toContain('"line-color": resolveColor("var(--wx-outline)")');
    const dash = readFileSync(
      join(SRC, "app/[location]/map/MapDashboard.tsx"),
      "utf8",
    );
    expect(dash).toContain("ring-1 ring-wx-outline");
  });

  it("frost borders hold 3:1 on the card in both themes", () => {
    for (const theme of THEMES) {
      for (const band of WEATHER_SCALES.find((s) => s.id === "frost")!.bands) {
        expect(
          contrastRatio(tokenHex(theme, band.token), CARD[theme]),
          `${theme} ${band.token}`,
        ).toBeGreaterThanOrEqual(3);
      }
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

  it("classifies UV on the raw value (no rounding), as uvLevel always has", () => {
    // WHO ranges are written as whole numbers; we found no WHO/EPA text to cite
    // for rounding first, so upper bounds are inclusive at 2, 5, 7 and 10:
    // 2 is Low, 2.4 is already Moderate, 5.5 is High, 10.4 is Extreme.
    expect(uvBand(2)!.name).toBe("Low");
    expect(uvBand(2.4)!.name).toBe("Moderate");
    expect(uvBand(5)!.name).toBe("Moderate");
    expect(uvBand(5.5)!.name).toBe("High");
    expect(uvBand(10)!.name).toBe("Very high");
    expect(uvBand(10.4)!.name).toBe("Extreme");
  });

  it("marks which scales are standards and which are ours", () => {
    const status = Object.fromEntries(
      WEATHER_SCALES.map((s) => [s.id, s.status]),
    );
    expect(status.aqi).toBe("published");
    expect(status.uv).toBe("published");
    expect(status.cloud).toBe("ours");
    expect(status.frost).toBe("ours");
    expect(PSI_SCALE.status).toBe("ours");
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
    const beaufortKmh = [0, 1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
    for (const band of WIND_SCALE.bands)
      expect(beaufortKmh).toContain(band.from);
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
    for (const v of [0, 2, 2.4, 2.6, 5, 5.5, 7, 10, 11, 14]) {
      expect(uvLevel(v).swatch).toBe(uvBand(v)!.bg);
    }
  });

  it("captions the Tomorrow.io tile legends as a reference scale", () => {
    for (const id of [
      "precipitationIntensity",
      "temperature",
      "windSpeed",
      "cloudCover",
    ]) {
      const chip = MAP_CHIPS.find((c) => c.id === id)!;
      expect(chip.legend.note).toBe(
        "Reference scale; map shading from Tomorrow.io",
      );
    }
    // Our own AQI grid and model fields are painted by us: no caption.
    expect(
      MAP_CHIPS.find((c) => c.id === "airQuality")!.legend.note,
    ).toBeUndefined();
  });
});

describe("Singapore PSI bands", () => {
  it("uses NEA's names and ranges with EPA colours where the ranges match", () => {
    expect(PSI_SCALE.bands.map((b) => b.name)).toEqual([
      "Good",
      "Moderate",
      "Unhealthy",
      "Very unhealthy",
      "Hazardous",
    ]);
    expect(PSI_SCALE.bands.map((b) => b.from)).toEqual([0, 51, 101, 201, 301]);
    // 0-50, 51-100, 201-300, 301+ equal the EPA ranges, so they take the EPA fill.
    expect(PSI_SCALE.bands[0].token).toBe(AQI_SCALE.bands[0].token);
    expect(PSI_SCALE.bands[1].token).toBe(AQI_SCALE.bands[1].token);
    expect(PSI_SCALE.bands[3].token).toBe(AQI_SCALE.bands[4].token);
    expect(PSI_SCALE.bands[4].token).toBe(AQI_SCALE.bands[5].token);
  });
});

describe("briefing PDF flight-category colours", () => {
  it("are the on-screen flight colours (FLIGHT_SCALE tokens in globals.css)", () => {
    for (const band of FLIGHT_SCALE.bands) {
      const pdf = FLIGHT_CATEGORY_PDF[band.name];
      expect(pdf, band.name).toBeDefined();
      expect(pdf.bg).toBe(tokenHex("light", band.token));
      expect(pdf.bg).toBe(tokenHex("dark", band.token));
      expect(pdf.fg).toBe(
        band.on === "text-wx-fg-dark" ? "#0a0a0a" : "#ffffff",
      );
      expect(contrastRatio(pdf.bg, pdf.fg)).toBeGreaterThanOrEqual(4.5);
    }
    expect(Object.keys(FLIGHT_CATEGORY_PDF).sort()).toEqual(
      ["IFR", "LIFR", "MVFR", "VFR"].sort(),
    );
  });

  it("IFR is red and LIFR is magenta on paper as on screen", () => {
    const [vfr, mvfr, ifr, lifr] = ["VFR", "MVFR", "IFR", "LIFR"].map(
      (k) => FLIGHT_CATEGORY_PDF[k].bg,
    );
    expect(ifr).toBe("#d62828");
    expect(lifr).toBe("#c026d3");
    expect(new Set([vfr, mvfr, ifr, lifr]).size).toBe(4);
  });

  it("AviationBriefingPDF reads the scale and keeps no flight-colour hex of its own", () => {
    const src = readFileSync(
      join(SRC, "app/aviation/AviationBriefingPDF.tsx"),
      "utf8",
    );
    expect(src).toContain("FLIGHT_CATEGORY_PDF");
    for (const old of ["#ea580c", "#dc2626", "#16a34a", "#2563eb"]) {
      expect(src).not.toContain(old);
    }
  });
});

describe("no brand mineral in a weather data encoding (whole of src)", () => {
  /**
   * Every non-test file under src that names a Mzizi mineral, the severity
   * ramp or the categorical chart tokens must be listed here with the reason
   * it is allowed. A weather value is never one of those reasons: weather data
   * colours come from weather-scales.ts. A stale entry (the file no longer
   * matches) fails too, so the list cannot rot.
   */
  const CHROME = "UI chrome (not a weather value)";
  const ALLOWLIST: Record<string, string> = {
    "app/api/og/route.tsx": "OG image: documented hex exception (Satori)",
    "app/aviation/AviationPlanner.tsx": `${CHROME}: warning text`,
    "app/history/HistoryDashboard.tsx":
      "activity suitability rating colours (a rating, not a physical scale)",
    "app/shamwari/ShamwariPageClient.tsx": CHROME,
    "app/status/StatusDashboard.tsx": "service status, not weather",
    "components/profile/GroupedRow.tsx": CHROME,
    "components/profile/ProfileIdentity.tsx": CHROME,
    "components/releases/ReleaseEntry.tsx": CHROME,
    "components/ui/alert.tsx": `${CHROME}: alert variants`,
    "components/ui/inline-error.tsx": `${CHROME}: error tone`,
    "components/ui/status-indicator.tsx": "service status, not weather",
    "components/ui/chart.tsx":
      "resolveColor fallback tables name both token families",
    "components/weather/AISummary.tsx": CHROME,
    "components/weather/ActivityInsights.tsx":
      "KNOWN REMAINING: heat-stress level labels still use the severity ramp; the heat index needs its own scale (NWS heat index convention), follow-up",
    "components/weather/AgricultureBriefing.tsx": `${CHROME}: farming category brand`,
    "components/weather/AgricultureCropAdvice.tsx": `${CHROME}: farming category brand`,
    "components/weather/AgricultureSnapshot.tsx": `${CHROME}: farming category brand`,
    "components/weather/AtmosphericSummary.tsx": `${CHROME}: tile borders`,
    "components/weather/CommunityLane.tsx":
      "activity category colours (a rating lane, not a physical value)",
    "components/weather/HistoryAnalysis.tsx": CHROME,
    "components/weather/LocationPromptCard.tsx": CHROME,
    "components/weather/LocationWeatherCard.tsx": "destructive menu item text",
    "components/weather/MetricCard.tsx":
      "generic gauge keeps its severity stroke ramp for non-scale callers (wx strokes are handled first and solid)",
    "components/weather/MyWeatherModal.tsx": CHROME,
    "components/weather/ShamwariCTA.tsx": CHROME,
    "components/weather/ShamwariSignInCTA.tsx": CHROME,
    "components/weather/charts/DaylightChart.tsx":
      "daylight hours: no weather colour convention",
    "components/weather/charts/FeasibilityChart.tsx":
      "activity category colours (suitability, not a physical value)",
    "components/weather/charts/GDDChart.tsx":
      "growing degree days (agronomy): no weather colour convention",
    "components/weather/charts/ModelComparisonChart.tsx":
      "series identify a forecast model, not a value",
    "components/weather/charts/RainEtChart.tsx":
      "ET0 line: no convention (the rain series uses the rain token)",
    "components/weather/charts/SoilMoistureChart.tsx":
      "categorical soil depths",
    "components/weather/charts/SoilTemperatureChart.tsx":
      "categorical soil depths",
    "components/weather/charts/SprayWindowChart.tsx":
      "agronomy decision windows (no convention)",
    "components/weather/charts/WaterBalanceChart.tsx":
      "agronomy water balance (no convention)",
    "components/weather/map/MapLibreMap.tsx": `${CHROME}: map notice pill border`,
    "components/weather/reports/RecentReports.tsx":
      "community report severity badge (ordinal label, not a physical scale)",
    "components/weather/reports/WeatherReportModal.tsx": CHROME,
    "components/weather/widgets/SunArc.tsx":
      "sun-path illustration, not a value encoding",
    "lib/activities.ts": "activity category colours (CATEGORY_STYLES)",
    "lib/agriculture.ts":
      "go / wait / avoid verdict colours (a decision, not a physical value)",
    "lib/hero.ts": "activity category dots on the hero plate",
    "lib/location-card.ts": "condition sky plates for place cards (UI surface)",
    "lib/map-layers.ts":
      "MAP_LAYERS layer-toggle chip styles (chrome); legends and fills are asserted clean below",
    "lib/seed-categories.ts": "activity category seed styles",
    "lib/seed-suitability-rules.ts": "suitability rating classes",
    "lib/suitability.ts": "suitability rating classes",
  };

  const TOKEN_RE =
    /mineral-|severity-|var\(--chart-\d\)|--color-severity|--chart-\d|--mineral/;

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name))
        out.push(full);
    }
    return out;
  }

  const hits = walk(SRC)
    .filter((f) => TOKEN_RE.test(readFileSync(f, "utf8")))
    .map((f) => relative(SRC, f).replaceAll("\\", "/"))
    .sort();

  it("lists every file that uses a mineral, severity or categorical chart token", () => {
    const unlisted = hits.filter((f) => !(f in ALLOWLIST));
    expect(
      unlisted,
      "A weather value must use weather-scales.ts (--wx-* tokens). If this is genuine UI chrome, add it to the allowlist with a reason.",
    ).toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    expect(Object.keys(ALLOWLIST).filter((f) => !hits.includes(f))).toEqual([]);
  });

  it("keeps minerals and severity tokens out of the weather data modules", () => {
    for (const f of [
      "aq-grid.ts",
      "model-grid.ts",
      "flight-category-styles.ts",
      "frost-styles.ts",
      "haze.ts",
      "display.ts",
      "sg-air.ts",
    ]) {
      expect(readFileSync(join(SRC, "lib", f), "utf8"), f).not.toMatch(
        TOKEN_RE,
      );
    }
    // The layer TOGGLE buttons (MAP_LAYERS styles) are chrome and keep minerals;
    // everything from the legends down is data.
    const layers = readFileSync(join(SRC, "lib/map-layers.ts"), "utf8");
    expect(layers.slice(layers.indexOf("export const AQI_LEGEND"))).not.toMatch(
      TOKEN_RE,
    );
  });

  it("keeps the brand ramps out of the gradient presets", () => {
    const geo = readFileSync(
      join(SRC, "components/weather/widgets/geometry.ts"),
      "utf8",
    );
    expect(geo).not.toMatch(TOKEN_RE);
  });
});

describe("temperature charts tell their series apart", () => {
  for (const file of [
    "components/weather/DailyChart.tsx",
    "components/weather/charts/TemperatureTrendChart.tsx",
  ]) {
    it(`${file}: every series has its own colour (Feels High is not Feels Low)`, () => {
      const src = readFileSync(join(SRC, file), "utf8");
      const colours = [...src.matchAll(/color:\s*(WX_SERIES\.\w+)/g)].map(
        (m) => m[1],
      );
      expect(colours.length).toBe(4);
      expect(new Set(colours).size).toBe(4);
      const feelsLow = src.match(
        /label:\s*"Feels Low",\s*color:\s*(WX_SERIES\.\w+)/,
      );
      expect(feelsLow?.[1]).toBe("WX_SERIES.feelsLow");
    });
  }
});
