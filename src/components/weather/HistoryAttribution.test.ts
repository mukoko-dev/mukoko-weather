import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HistoryAttribution } from "./HistoryAttribution";

const POWER = {
  id: "nasa-power",
  name: "NASA POWER",
  attribution:
    "Data obtained from the NASA Langley Research Center POWER Project",
  url: "https://power.larc.nasa.gov",
  licence: "NASA open data",
  licenceUrl: "https://www.earthdata.nasa.gov/x",
};
const OM = {
  id: "open-meteo-archive",
  name: "Open-Meteo (ERA5)",
  attribution: "Weather data by Open-Meteo.com",
  url: "https://open-meteo.com",
  licence: "CC BY 4.0",
  licenceUrl: null,
};

describe("HistoryAttribution", () => {
  it("renders nothing when every day was recorded live", () => {
    expect(
      renderToStaticMarkup(createElement(HistoryAttribution, { sources: [] })),
    ).toBe("");
  });

  it("credits each archive source with a link and its licence", () => {
    const html = renderToStaticMarkup(
      createElement(HistoryAttribution, { sources: [POWER, OM] }),
    );
    expect(html).toContain('aria-label="Data sources"');
    expect(html).toContain('data-source="nasa-power"');
    expect(html).toContain('data-source="open-meteo-archive"');
    expect(html).toContain('href="https://power.larc.nasa.gov"');
    expect(html).toContain("NASA Langley Research Center");
    expect(html).toContain('rel="noopener noreferrer license"');
    expect(html).toContain("CC BY 4.0");
  });

  it("uses global styles only", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync(
      "src/components/weather/HistoryAttribution.tsx",
      "utf-8",
    );
    expect(src).not.toMatch(/style=\{\{/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{6}/);
  });
});
