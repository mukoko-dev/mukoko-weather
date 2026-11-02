import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PollutantBar, severityBarWidth } from "./AirQualityDetails";
import { aqiScalePct } from "@/lib/air-quality-details";

const render = (subIndex: number | undefined) =>
  renderToStaticMarkup(React.createElement(PollutantBar, { subIndex }));

describe("severityBarWidth", () => {
  it("is where the sub-index sits on the Air quality card's bar", () => {
    for (const sub of [0, 25, 74, 150, 250, 500]) {
      expect(severityBarWidth(sub)).toBe(aqiScalePct(sub));
    }
    expect(severityBarWidth(undefined)).toBe(0);
  });
});

describe("PollutantBar", () => {
  it("fills with a window onto the blended AQI gradient, not one solid band colour", () => {
    const html = render(74);
    expect(html.match(/linear-gradient\(/g)).toHaveLength(1);
    for (let i = 1; i <= 6; i++) expect(html).toContain(`var(--wx-aqi-${i})`);
    expect(html).not.toMatch(/\bbg-wx-aqi-\d/);
  });

  it("keeps the track outline and stays decorative", () => {
    const html = render(74);
    expect(html).toContain("ring-wx-outline");
    expect(html).toContain('aria-hidden="true"');
  });

  it("draws no fill for a missing or zero sub-index", () => {
    expect(render(undefined)).not.toContain("linear-gradient");
    expect(render(0)).not.toContain("linear-gradient");
  });

  it("windows the fill to the sub-index (74 is 24.67% of the bar)", () => {
    const html = render(74);
    expect(html).toContain("width:24.67%");
    // The gradient inside is the full track: 100 / 0.2467 = 405.41% of the fill.
    expect(html).toContain("width:405.41%");
  });
});

describe("AirQualityDetails source", () => {
  it("has no hex, rgba or solid band colour class", () => {
    const src = readFileSync(join(__dirname, "AirQualityDetails.tsx"), "utf8");
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/rgba?\(/);
    expect(src).not.toContain("severityBarClass");
  });
});
