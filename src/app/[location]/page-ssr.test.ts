/**
 * /[location] SSR — the shell and the place only (issue #414).
 *
 * The page awaits the place (layout), the season (database, bounded) and the
 * signed-in user. It never awaits weather: the visitor's own browser fetches
 * the forecast. The pages-make-no-weather-call guard for the whole render
 * path is src/app/place-pages-no-weather.test.ts.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const page = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");
const body = page.slice(
  page.indexOf("export default async function LocationPage"),
);

describe("LocationPage — what the render waits on", () => {
  it("starts the season and the user together, and bounds the season", () => {
    const group = body.slice(
      body.indexOf("await Promise.all(["),
      body.indexOf("]);", body.indexOf("await Promise.all([")),
    );
    expect(group).toContain("seasonWithinBudget(");
    expect(group).toContain("getCurrentUser()");
  });

  it("hands the stage a place with no weather", () => {
    expect(body).toContain("<PlaceStage");
    expect(body).toContain("seed={{ location, season, countryName }}");
    expect(body).not.toContain("weather={");
  });

  it("never reconciles against a forecast it does not have", () => {
    expect(body).not.toContain("reconcileCountry(");
    expect(body).not.toContain("reconcileElevation(");
  });

  it("keeps Place, BreadcrumbList and FAQPage structured data without observations", () => {
    expect(body).toContain('"@type": "Place"');
    expect(body).toContain("breadcrumbJsonLd(");
    expect(body).toContain('"@type": "FAQPage"');
    expect(body).not.toContain('"@type": "Observation"');
    expect(body).not.toContain("weather.current");
  });
});
