/**
 * What the My Weather forecast-model picker OFFERS. Apple Weather is a row
 * only while its feature flag is on: until the Servers API origin serves it, a
 * row that does nothing would be a lie.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPEN_METEO_MODEL_OPTIONS,
  modelOptions,
} from "./forecast-model-options";
import { isExternalForecastModel } from "./forecast-sources";
import { ForecastModel } from "./weather";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("modelOptions", () => {
  it("does not offer Apple Weather while it is off (the shipped default)", () => {
    const values = modelOptions().map((o) => o.value);
    expect(values).not.toContain(ForecastModel.AppleWeatherKit);
    expect(modelOptions()).toEqual(OPEN_METEO_MODEL_OPTIONS);
    expect(modelOptions(false)).toEqual(OPEN_METEO_MODEL_OPTIONS);
  });

  it("offers it last, with its name, once it is on", () => {
    const options = modelOptions(true);
    expect(options).toHaveLength(OPEN_METEO_MODEL_OPTIONS.length + 1);
    expect(options.at(-1)).toEqual({
      value: ForecastModel.AppleWeatherKit,
      label: "Apple Weather",
    });
    // The rest are untouched, in order.
    expect(options.slice(0, -1)).toEqual(OPEN_METEO_MODEL_OPTIONS);
  });

  it("follows the dev override when no flag value is passed", () => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (k === "ff:apple_weatherkit" ? "true" : null),
    });
    expect(modelOptions().map((o) => o.value)).toContain(
      ForecastModel.AppleWeatherKit,
    );
  });

  it("starts with the blend, and every always-offered model is an Open-Meteo one", () => {
    expect(OPEN_METEO_MODEL_OPTIONS[0].value).toBe(ForecastModel.BestMatch);
    for (const o of OPEN_METEO_MODEL_OPTIONS) {
      expect(isExternalForecastModel(o.value), o.value).toBe(false);
    }
  });

  it("has a label and a unique value for every row", () => {
    const rows = modelOptions(true);
    expect(new Set(rows.map((o) => o.value)).size).toBe(rows.length);
    for (const o of rows) expect(o.label.length).toBeGreaterThan(0);
  });
});
