import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { slugFromLocationPath } from "@/lib/device-weather";

const read = (p: string) => readFileSync(resolve(__dirname, p), "utf-8");
const snapshot = read("DeviceSnapshot.tsx");
const updatedAgo = read("UpdatedAgo.tsx");
const loading = read("../../app/[location]/loading.tsx");
const dashboard = read("../../app/[location]/WeatherDashboard.tsx");
const home = read("../../app/CurrentLocationHome.tsx");

describe("slugFromLocationPath", () => {
  it("reads the slug of a /{slug} page only", () => {
    expect(slugFromLocationPath("/harare")).toBe("harare");
    expect(slugFromLocationPath("/nairobi-ke/")).toBe("nairobi-ke");
    expect(slugFromLocationPath("/harare/forecast")).toBeNull();
    expect(slugFromLocationPath("/")).toBeNull();
    expect(slugFromLocationPath(null)).toBeNull();
    expect(slugFromLocationPath("/%E0%A4%A")).toBeNull();
  });
});

describe("device paint on the location loading boundary (issue #269)", () => {
  it("loading.tsx renders the device-aware loader", () => {
    expect(loading).toContain("DeviceLocationLoading");
  });
  it("falls back to the structural skeleton when nothing is stored", () => {
    expect(snapshot).toContain("recallPlace(slug)");
    expect(snapshot).toContain("<LocationSkeleton slug={slug} />");
    expect(snapshot).not.toContain("WeatherLoadingScene");
  });
  it("paints only presentational sections — no network-backed cards", () => {
    for (const heavy of [
      "AISummary",
      "MapPreview",
      "RecentReports",
      "fetch(",
    ]) {
      expect(snapshot).not.toContain(heavy);
    }
    expect(snapshot).toContain("<CurrentConditions");
    expect(snapshot).toContain("<HourlyScrollCards");
    expect(snapshot).toContain("<DailyForecast");
  });
  it("labels the snapshot as saved on this device for assistive tech", () => {
    expect(snapshot).toContain("(saved on this device)");
    expect(snapshot).toContain('aria-labelledby="device-hourly-heading"');
  });
  it("shows how old the data is and the place's own time", () => {
    expect(snapshot).toContain("<UpdatedAgo");
    expect(updatedAgo).toContain("placeClockLabel");
    expect(updatedAgo).toContain("Forecast for this hour");
    expect(updatedAgo).toContain('aria-hidden="true"');
  });
});

describe("WeatherDashboard writes the device store", () => {
  it("remembers fetched payloads, never fallbacks or device copies", () => {
    expect(dashboard).toContain("rememberPlace(");
    expect(dashboard).toMatch(
      /if \(fromDevice \|\| seedUsingFallback\) return;/,
    );
  });
  it("pins saved places, home and the selected location", () => {
    expect(dashboard).toContain("savedLocations");
    expect(dashboard).toContain("homeLocation");
  });
  it("shows the Updated line only for device payloads", () => {
    expect(dashboard).toMatch(/\{device && \(\s*<UpdatedAgo/);
  });
});

describe("home paints from the device when the server seeded nothing", () => {
  it("recalls the last home place and refreshes it in the background", () => {
    expect(home).toContain("LAST_HOME_PLACE_KEY");
    expect(home).toContain("recallPlace(slug)");
    expect(home).toContain("fetchHomeWeather(");
    expect(home).toContain("if (initial) return;");
  });
  it("uses safe-storage, never raw localStorage, for the pointer", () => {
    expect(home).toContain('from "@/lib/safe-storage"');
  });
});
