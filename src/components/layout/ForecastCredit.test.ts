/**
 * ForecastCredit: the attribution an external forecast provider requires,
 * rendered for real (react-dom/server) and checked where it is used.
 *
 * Apple's terms: wherever its weather data is displayed, its trademark and the
 * legal link to its data sources; for value-added data (the baseline), also a
 * notice that the data has been modified.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ForecastCredit } from "./ForecastCredit";

const LEGAL = "https://developer.apple.com/weatherkit/data-source-attribution/";

const html = (models: string[], use: "plotted" | "baseline") =>
  renderToStaticMarkup(createElement(ForecastCredit, { models, use }));

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("ForecastCredit rendered", () => {
  it("is nothing for the blend and every Open-Meteo model", () => {
    expect(html(["best_match", "ecmwf_ifs", "gfs_seamless"], "baseline")).toBe(
      "",
    );
    expect(html([], "plotted")).toBe("");
  });

  it("names Apple Weather and links the legal page, safely", () => {
    const out = html(["apple_weatherkit"], "plotted");
    expect(out).toContain("Apple Weather");
    expect(out).toContain(`href="${LEGAL}"`);
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain("Other data sources");
    // A series shown as it came needs no modified notice.
    expect(out).not.toContain("modified");
  });

  it("adds the modified notice for a baseline", () => {
    const out = html(["apple_weatherkit"], "baseline");
    expect(out).toContain("Apple Weather");
    expect(out).toContain(`href="${LEGAL}"`);
    expect(out).toContain("Data provided by Apple has been modified.");
  });

  it("renders one line however many of the provider's models are given", () => {
    const out = html(
      ["ecmwf_ifs", "apple_weatherkit", "apple_weatherkit"],
      "plotted",
    );
    expect(out.match(/data-forecast-provider=/g)).toHaveLength(1);
  });

  it("is a labelled list, with a full touch target and no hardcoded style", () => {
    const out = html(["apple_weatherkit"], "baseline");
    expect(out).toContain('aria-label="Forecast data sources"');
    expect(out).toContain("dik-dik");
    expect(out).not.toContain("style=");
    expect(out).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("source: no hex colours, no inline style", () => {
    const src = read("src/components/layout/ForecastCredit.tsx");
    expect(src).not.toContain("style={{");
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // The wording comes from forecast-sources, never hand-written here.
    expect(src).not.toContain("developer.apple.com");
    expect(src).not.toContain("Data provided by Apple");
  });
});

describe("where Apple's credit appears", () => {
  it("the model comparison chart credits a plotted Apple series", () => {
    const src = read("src/components/weather/charts/ModelComparisonChart.tsx");
    expect(src).toContain("<ForecastCredit");
    expect(src).toContain('use="plotted"');
    expect(src).toContain("models.map((m) => m.model)");
  });

  it("the picker credits Apple outside the radio rows (a link in a button is invalid)", () => {
    const src = read("src/components/weather/MyWeatherModal.tsx");
    expect(src).toContain("modelOptions()");
    const credit = src.indexOf("<ForecastCredit");
    expect(credit).toBeGreaterThan(-1);
    // After the rows have closed, not inside a SelectRow.
    expect(credit).toBeGreaterThan(src.lastIndexOf("</SelectRow>"));
    expect(src.slice(credit, credit + 200)).toContain('use="baseline"');
  });

  it("the dashboard credits the baseline only once the server confirmed it", () => {
    const src = read("src/app/[location]/WeatherDashboard.tsx");
    const at = src.indexOf("<ForecastCredit");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(src.lastIndexOf("{modelBaseline &&", at), at + 120);
    expect(block).toContain("{modelBaseline &&");
    // Nothing at all (not even the wrapper) for the blend or an Open-Meteo model.
    expect(block).toContain("isExternalForecastModel(model)");
    expect(block).toContain('use="baseline"');
  });

  it("the footer credits Apple only while the model is offered", () => {
    const src = read("src/components/layout/Footer.tsx");
    expect(src).toContain('isFeatureEnabled("apple_weatherkit")');
    const at = src.indexOf("<ForecastCredit");
    expect(at).toBeGreaterThan(-1);
    expect(
      src.slice(src.lastIndexOf("{appleWeatherEnabled", at), at),
    ).toContain("&&");
  });
});

describe("Apple Weather's chart colour", () => {
  const css = read("src/app/globals.css");
  const chart = read("src/components/ui/chart.tsx");

  it("is a token in both themes, registered for Tailwind, with a render-time fallback", () => {
    expect(css.match(/--chart-7:/g)).toHaveLength(2);
    expect(css).toContain("--color-chart-7: var(--chart-7);");
    expect(chart.match(/"--chart-7":/g)).toHaveLength(2);
  });
});
