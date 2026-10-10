/**
 * /[location] SSR — the independent lookups run alongside the weather fetch.
 *
 * Country, season and the signed-in user don't depend on the weather, so
 * they must start before the weather await, not after it (a weather cache
 * miss is the slow part of this render).
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const page = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");
const body = page.slice(
  page.indexOf("export default async function LocationPage"),
);

describe("LocationPage — parallel SSR lookups", () => {
  it("starts country, season and user before awaiting the weather", () => {
    const started = body.indexOf("const sideData = Promise.all([");
    const weather = body.indexOf("await getWeatherForLocation(");
    expect(started).toBeGreaterThan(-1);
    expect(weather).toBeGreaterThan(-1);
    expect(started).toBeLessThan(weather);
    const group = body.slice(started, body.indexOf("]);", started));
    expect(group).toContain("loadCountry(countryCode)");
    expect(group).toContain("getCachedSeason(");
    expect(group).toContain("getCurrentUser()");
  });

  it("awaits the started group instead of a second Promise.all", () => {
    expect(body).toContain("await sideData;");
    expect(body.match(/Promise\.all\(/g)).toHaveLength(1);
  });

  it("marks the early group handled so a rejection isn't reported as unhandled", () => {
    expect(body).toContain("void sideData.catch(() => {});");
  });
});
