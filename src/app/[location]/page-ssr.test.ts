/**
 * /[location] SSR — the shell, the place and nothing that waits on data
 * (issues #414 and #452).
 *
 * The page awaits its params and nothing else: the place comes from the seed
 * or the slug (`localPlaceForSlug`), the season from the prebuilt table, the
 * country name from the static list, and the signed-in person is read by the
 * client from AuthKit's provider. It never awaits weather either. The
 * pages-make-no-weather-call guard for the whole render path is
 * src/app/place-pages-no-weather.test.ts; the behaviour guard for "no await in
 * front of the shell" is src/app/shell-no-awaits.test.ts.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const page = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");
const body = page.slice(
  page.indexOf("export default async function LocationPage"),
);

describe("LocationPage — what the render waits on", () => {
  it("awaits only its params", () => {
    const awaits = [...body.matchAll(/\bawait\b[^;\n]*/g)].map((m) => m[0]);
    expect(awaits).toEqual(["await params"]);
  });

  it("names the place from the seed or the slug, and hands anything else to the browser", () => {
    expect(body).toContain("localPlaceForSlug(slug)");
    expect(body).toContain("<PlaceResolver slug={slug} />");
    expect(body).not.toContain("notFound(");
  });

  it("computes the season and the country name without a lookup", () => {
    expect(body).toContain("localSeason(");
    expect(body).toContain("countryDisplayName(");
    expect(page).not.toContain("seasonWithinBudget");
    expect(page).not.toContain("getCachedSeason");
    expect(page).not.toContain("getCountryByCode");
  });

  it("does not read the signed-in user on the server", () => {
    expect(page).not.toContain("getCurrentUser");
    expect(page).not.toContain("@/lib/auth");
  });

  it("hands the stage a place with no weather and no user", () => {
    expect(body).toContain("<PlaceStage");
    expect(body).toContain("seed={{ location, season, countryName }}");
    expect(body).not.toContain("weather={");
    expect(body).not.toContain("user={");
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

describe("LocationPage.generateMetadata", () => {
  const metadata = page.slice(
    page.indexOf("export async function generateMetadata"),
    page.indexOf("export default async function LocationPage"),
  );

  it("asks no store for a shipped place or a spot", () => {
    expect(metadata).toContain("localPlaceForSlug(slug) ??");
  });

  it("takes the OG season from the prebuilt table, not a database read", () => {
    expect(metadata).toContain("localSeason(");
    expect(metadata).not.toContain("getCachedSeason");
  });
});
