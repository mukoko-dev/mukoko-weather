import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SubRouteHeader } from "./SubRouteHeader";

const SEASON = {
  name: "Dry season",
  localName: "Chirimo",
  description: "Warm and dry",
};

function render(location: Parameters<typeof SubRouteHeader>[0]["location"]) {
  return renderToString(
    createElement(SubRouteHeader, {
      title: "Harare Forecast",
      location,
      season: SEASON,
    }),
  );
}

describe("SubRouteHeader", () => {
  it("is the heading, the place line and the season, all known without weather", () => {
    const html = render({ province: "Harare", elevation: 1490 });
    expect(html).toContain("<h1");
    expect(html).toContain("Harare Forecast");
    expect(html).toContain("Harare · 1490m · Chirimo (Dry season)");
    expect(html).toContain("Warm and dry");
  });

  it("leaves a placeholder height out instead of printing a measured 0m", () => {
    const html = render({
      province: "Harare",
      elevation: 0,
      elevationApproximate: true,
    });
    expect(html).not.toContain("0m");
    expect(html).toContain("Harare · Chirimo (Dry season)");
  });

  it("drops an empty province rather than printing a stray separator", () => {
    const html = render({ province: "", elevation: 1490 });
    expect(html).toContain("1490m · Chirimo (Dry season)");
    expect(html).not.toContain("> · ");
  });
});
