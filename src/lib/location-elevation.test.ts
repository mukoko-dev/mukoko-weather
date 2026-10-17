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

  it("is applied wherever a page shows a location", () => {
    for (const file of [
      "../app/[location]/page.tsx",
      "../app/page.tsx",
      "../app/CurrentLocationHome.tsx",
    ]) {
      const src = readFileSync(resolve(__dirname, file), "utf-8");
      expect(src).toContain("reconcileElevation(");
    }
  });

  it("marks every spot and IP-fallback placeholder as approximate", () => {
    const places = readFileSync(resolve(__dirname, "places.ts"), "utf-8");
    const home = readFileSync(resolve(__dirname, "home-location.ts"), "utf-8");
    expect(places.match(/elevationApproximate: true/g)?.length).toBe(2);
    expect(home).toContain("elevationApproximate: true");
  });

  it("matches the Python writer's field", () => {
    const py = readFileSync(
      resolve(__dirname, "../../api/py/_model_blend.py"),
      "utf-8",
    );
    expect(py).toContain('out["elevation"] = elevation');
  });
});
