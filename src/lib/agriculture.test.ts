import { describe, it, expect } from "vitest";
import fs from "fs";
import {
  FARMING_ACTIVITY_IDS,
  STATUS_LABELS,
  WINDOW_ORDER,
  agricultureUrl,
  dayLabel,
  farmingActivities,
  forecastDays,
  formatBalance,
  formatGdd,
  formatMm,
  formatMoisture,
  formatTempC,
  hhmm,
  isAgricultureReady,
  riskClass,
  statusClasses,
  type AgriDay,
  type AgricultureResponse,
} from "./agriculture";
import { ACTIVITIES } from "./activities";

describe("farming activities", () => {
  it("lists exactly the farming-category activities", () => {
    const farming = ACTIVITIES.filter((a) => a.category === "farming").map(
      (a) => a.id,
    );
    expect([...FARMING_ACTIVITY_IDS].sort()).toEqual([...farming].sort());
  });

  it("keeps farming ids in the user's order, de-duplicated", () => {
    expect(
      farmingActivities([
        "soccer",
        "tobacco-farming",
        "crop-farming",
        "tobacco-farming",
      ]),
    ).toEqual(["tobacco-farming", "crop-farming"]);
    expect(farmingActivities([])).toEqual([]);
  });
});

describe("agricultureUrl", () => {
  it("builds the public endpoint with location, country and crops", () => {
    const url = agricultureUrl(
      { slug: "harare", lat: -17.83, lon: 31.05, country: "ZW" },
      ["crop-farming", "tobacco-farming"],
    );
    expect(url).toBe(
      "/api/py/agriculture?lat=-17.83&lon=31.05&location=harare&country=ZW&crops=crop-farming%2Ctobacco-farming",
    );
  });

  it("omits empty country and crops", () => {
    expect(agricultureUrl({ slug: "x", lat: 1, lon: 2 })).toBe(
      "/api/py/agriculture?lat=1&lon=2&location=x",
    );
  });
});

describe("status + risk classes", () => {
  it("maps statuses to severity tokens only", () => {
    expect(statusClasses("go").dot).toBe("bg-severity-low");
    expect(statusClasses("wait").text).toBe("text-severity-moderate");
    expect(statusClasses("avoid").soft).toBe("bg-severity-severe/15");
    for (const s of ["go", "wait", "avoid"] as const) {
      for (const cls of Object.values(statusClasses(s)))
        expect(cls).toMatch(/severity-/);
    }
    expect(riskClass("high")).toBe("text-severity-severe");
    expect(riskClass("none")).toBe("text-severity-low");
  });

  it("labels and window order", () => {
    expect(STATUS_LABELS.avoid).toBe("Hold off");
    expect(WINDOW_ORDER).toEqual(["spray", "plant", "harvest", "irrigate"]);
  });
});

describe("formatters", () => {
  it("formats rain, balance, moisture, temperature and GDD", () => {
    expect(formatMm(null)).toBe("—");
    expect(formatMm(0)).toBe("0 mm");
    expect(formatMm(2.34)).toBe("2.3 mm");
    expect(formatMm(18.6)).toBe("19 mm");
    expect(formatBalance(-18.4)).toBe("−18 mm");
    expect(formatBalance(6)).toBe("+6 mm");
    expect(formatBalance(0.2)).toBe("0 mm");
    expect(formatBalance(undefined)).toBe("—");
    expect(formatMoisture(0.274)).toBe("27%");
    expect(formatTempC(18.6)).toBe("19°C");
    expect(formatGdd(359.6)).toBe("360");
    expect(hhmm("2026-10-11T06:00")).toBe("06:00");
    expect(dayLabel("2026-10-13")).toBe("13 Oct");
    expect(dayLabel("bad")).toBe("bad");
  });
});

describe("readiness + forecast slicing", () => {
  it("needs available data with windows and rain", () => {
    expect(isAgricultureReady(null)).toBe(false);
    expect(
      isAgricultureReady({ available: false } as AgricultureResponse),
    ).toBe(false);
    expect(
      isAgricultureReady({
        available: true,
        windows: {},
        rain: {},
        headline: "Good day to spray.",
        verdict: "go",
      } as unknown as AgricultureResponse),
    ).toBe(true);
    // A missing verdict or headline is never papered over with a made-up one.
    expect(
      isAgricultureReady({
        available: true,
        windows: {},
        rain: {},
        headline: null,
        verdict: "go",
      } as unknown as AgricultureResponse),
    ).toBe(false);
  });

  it("keeps forecast days only", () => {
    const days = [
      { date: "2026-10-10", forecast: false },
      { date: "2026-10-11", forecast: true },
    ] as AgriDay[];
    expect(forecastDays(days).map((d) => d.date)).toEqual(["2026-10-11"]);
  });
});

describe("mirrors the Python model", () => {
  it("every AgricultureResponse field exists in api/py/_agriculture.py", () => {
    const py = fs.readFileSync("api/py/_agriculture.py", "utf-8");
    for (const field of [
      "headline",
      "verdict",
      "windows",
      "waterBalance",
      "sprayWindows",
      "daily",
      "calendar",
      "profile",
      "utcOffsetSeconds",
      "soilMoisture27to81",
      "soilTemp54",
      "leafWetHours",
      "sprayHours",
    ]) {
      expect(py, field).toContain(`${field}:`);
    }
  });
});
