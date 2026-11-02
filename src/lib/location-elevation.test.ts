import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { reconcileElevation } from "./location-elevation";
import type { WeatherLocation } from "./locations";

const spot: WeatherLocation = {
  slug: "phuket--w1muzh7",
  name: "Phuket",
  province: "",
  lat: 7.89,
  lon: 98.39,
  elevation: 0,
  elevationApproximate: true,
  tags: ["city"],
};

describe("reconcileElevation (#302)", () => {
  it("takes the forecast's terrain height for an approximate elevation", () => {
    const out = reconcileElevation(spot, 6.4);
    expect(out.elevation).toBe(6);
    expect(out.elevationApproximate).toBe(false);
    expect(spot.elevation).toBe(0); // input untouched
  });

  it("keeps a stored elevation", () => {
    const harare = {
      ...spot,
      elevation: 1490,
      elevationApproximate: undefined,
    };
    expect(reconcileElevation(harare, 1500)).toBe(harare);
  });

  it.each([undefined, null, Number.NaN, -9999, 9500])(
    "ignores a non-measurement (%s)",
    (value) => {
      expect(reconcileElevation(spot, value as number | null | undefined)).toBe(
        spot,
      );
    },
  );

  it("keeps real below-sea-level land", () => {
    expect(reconcileElevation(spot, -258).elevation).toBe(-258);
  });

  it("is applied wherever a forecast reaches a location", () => {
    // The server pages hold no forecast (issue #414); the place stage applies
    // it when the visitor's own forecast arrives, for `/`, `/[location]` and
    // every place switch alike. The server's structured data leaves a
    // placeholder height out instead of publishing it.
    const controller = readFileSync(
      resolve(__dirname, "place-controller.ts"),
      "utf-8",
    );
    expect(controller).toContain("reconcileElevation(");
    const page = readFileSync(
      resolve(__dirname, "../app/[location]/page.tsx"),
      "utf-8",
    );
    expect(page).toContain("location.elevationApproximate");
  });

  it("marks every spot and IP-fallback placeholder as approximate", () => {
    const places = readFileSync(resolve(__dirname, "places.ts"), "utf-8");
    const home = readFileSync(resolve(__dirname, "home-location.ts"), "utf-8");
    expect(places.match(/elevationApproximate: true/g)?.length).toBe(2);
    expect(home).toContain("elevationApproximate: true");
  });

  it("matches the Worker's field", () => {
    const rust = readFileSync(
      resolve(__dirname, "../../workers/crates/weather-core/src/blend.rs"),
      "utf-8",
    );
    expect(rust).toMatch(/insert\(\s*"elevation"/);
  });
});
