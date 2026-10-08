import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PSI_BAND_TEXT_CLASS,
  isSgAir,
  psiBandInfo,
  psiBandKey,
  sgRegionLabel,
} from "./sg-air";
import { DISPLAY_REFRESH_MS } from "./display";

describe("psiBandKey", () => {
  it.each([
    [0, "good"],
    [50, "good"],
    [51, "moderate"],
    [100, "moderate"],
    [101, "unhealthy"],
    [200, "unhealthy"],
    [201, "very_unhealthy"],
    [300, "very_unhealthy"],
    [301, "hazardous"],
    [900, "hazardous"],
  ])("PSI %i is %s", (value, key) => {
    expect(psiBandKey(value)).toBe(key);
  });

  it("rejects non-finite values", () => {
    expect(() => psiBandKey(Number.NaN)).toThrow(RangeError);
    expect(() => psiBandKey(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("psiBandInfo", () => {
  it("returns label and severity class for the band", () => {
    expect(psiBandInfo(140)).toEqual({
      key: "unhealthy",
      label: "Unhealthy",
      textClass: "text-severity-severe",
    });
  });

  it("uses only severity tokens, never raw colour utilities", () => {
    for (const cls of Object.values(PSI_BAND_TEXT_CLASS)) {
      expect(cls).toMatch(/^text-severity-(low|moderate|high|severe|extreme)$/);
    }
  });

  it("every band has a distinct label", () => {
    const labels = [0, 75, 150, 250, 350].map((v) => psiBandInfo(v).label);
    expect(new Set(labels).size).toBe(5);
  });
});

describe("sgRegionLabel", () => {
  it("capitalises known regions", () => {
    expect(sgRegionLabel("west")).toBe("West");
    expect(sgRegionLabel("central")).toBe("Central");
  });

  it("passes unknown ids through", () => {
    expect(sgRegionLabel("islands")).toBe("islands");
  });
});

describe("isSgAir", () => {
  const ok = {
    available: true,
    source: "NEA via data.gov.sg",
    observedAt: "2026-10-08T22:00:00+08:00",
    fetchedAt: null,
    psi24h: 140,
    psiBasis: "highest_region",
    band: "unhealthy",
    bandLabel: "Unhealthy",
    pm25OneHour: 158,
    pm25Basis: "highest_region",
    regions: [],
    nearestRegion: "central",
  };

  it("accepts a successful reading", () => {
    expect(isSgAir(ok)).toBe(true);
  });

  it("accepts an unavailable response (a reported failure, not a bad shape)", () => {
    expect(isSgAir({ available: false, source: "NEA via data.gov.sg" })).toBe(
      true,
    );
  });

  it("rejects a reading without a numeric PSI", () => {
    expect(isSgAir({ ...ok, psi24h: null })).toBe(false);
    expect(isSgAir({ ...ok, psi24h: "140" })).toBe(false);
  });

  it("rejects bodies without an availability flag", () => {
    expect(isSgAir({ error: "x" })).toBe(false);
    expect(isSgAir(null)).toBe(false);
    expect(isSgAir("nope")).toBe(false);
  });
});

describe("display wiring for the NEA panel", () => {
  const root = join(__dirname, "..");
  const read = (p: string) => readFileSync(join(root, p), "utf8");

  it("polls the endpoint only for Singapore, every 15 minutes", () => {
    const dash = read("app/display/DisplayDashboard.tsx");
    expect(dash).toMatch(/location\.country === "SG"/);
    expect(dash).toContain("/api/py/sg-air?");
    expect(DISPLAY_REFRESH_MS.sgAir).toBe(15 * 60 * 1000);
  });

  it("renders the panel inside the air-quality card, in its own boundary", () => {
    const dash = read("app/display/DisplayDashboard.tsx");
    expect(dash).toMatch(
      /<DisplayAirQuality air=\{air\}>[\s\S]*<ChartErrorBoundary name="official NEA reading">[\s\S]*<DisplaySgPsi/,
    );
  });

  it("resolves the country on the server and passes it to the dashboard", () => {
    const page = read("app/display/page.tsx");
    expect(page).toMatch(/country: location\.country/);
    expect(page).toMatch(/country: near\?\.country \?\? null/);
  });
});
