import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  MODEL_EXTRAS_ROOT_MARGIN,
  shouldFetchModelExtras,
} from "./dashboard-fetch-policy";
import { isNearViewport } from "./use-near-viewport";

describe("shouldFetchModelExtras", () => {
  it("waits for the end of the main column with the default blend", () => {
    expect(shouldFetchModelExtras("best_match", false)).toBe(false);
    expect(shouldFetchModelExtras("best_match", true)).toBe(true);
  });

  it("fetches a picked model at once (it becomes the page baseline)", () => {
    expect(shouldFetchModelExtras("gfs_seamless", false)).toBe(true);
    expect(shouldFetchModelExtras("ecmwf_ifs", false)).toBe(true);
  });

  it("uses a generous prefetch margin", () => {
    expect(
      Number.parseInt(MODEL_EXTRAS_ROOT_MARGIN, 10),
    ).toBeGreaterThanOrEqual(800);
  });
});

describe("isNearViewport", () => {
  it("follows the observer entry", () => {
    expect(isNearViewport({ isIntersecting: true })).toBe(true);
    expect(isNearViewport({ isIntersecting: false })).toBe(false);
  });
});

describe("dashboard wiring — below-the-fold fetches are deferred", () => {
  const dashboard = readFileSync(
    resolve(__dirname, "../app/[location]/WeatherDashboard.tsx"),
    "utf-8",
  );
  const atmospheric = readFileSync(
    resolve(__dirname, "../components/weather/AtmosphericSummary.tsx"),
    "utf-8",
  );

  it("gates the models/nowcast fetch on shouldFetchModelExtras", () => {
    expect(dashboard).toContain("shouldFetchModelExtras(model, extrasNear)");
    expect(dashboard).toContain("if (!fetchExtras) return;");
  });

  it("observes an out-of-flow sentinel at the end of the main column", () => {
    expect(dashboard).toContain("ref={extrasSentinelRef}");
    expect(dashboard).toContain("absolute bottom-0");
  });

  it("fetches climate normals only once the Conditions grid is near", () => {
    expect(atmospheric).toContain('useNearViewport(sectionRef, "600px")');
    expect(atmospheric).toContain("if (!enabled) return;");
  });
});
