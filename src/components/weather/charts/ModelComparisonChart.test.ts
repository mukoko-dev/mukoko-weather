import { describe, it, expect } from "vitest";
import { prepareModelComparisonData, MODEL_COLORS, MODEL_SWATCH_CLASS } from "./ModelComparisonChart";
import { ForecastModel, type ModelForecast } from "@/lib/weather";

const MODELS: ModelForecast[] = [
  { model: ForecastModel.GFS, temperature_2m: [20, 21, 22], precipitation: [0, 0, 0.1] },
  { model: ForecastModel.ECMWF, temperature_2m: [19, 20, 21], precipitation: [0, 0.1, 0] },
];
const TIME = ["2025-01-01T00:00", "2025-01-01T01:00", "2025-01-01T02:00"];

describe("prepareModelComparisonData", () => {
  it("builds one row per time step keyed by model id", () => {
    const { rows } = prepareModelComparisonData(MODELS, TIME);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      t: "2025-01-01T00:00",
      [ForecastModel.GFS]: 20,
      [ForecastModel.ECMWF]: 19,
    });
  });

  it("emits a series config per model with a mineral colour token", () => {
    const { series } = prepareModelComparisonData(MODELS, TIME);
    expect(series).toHaveLength(2);
    expect(series[0].key).toBe(ForecastModel.GFS);
    expect(series[0].color).toBe(MODEL_COLORS[ForecastModel.GFS]);
    expect(series[0].color.startsWith("var(--")).toBe(true);
  });

  it("caps rows at 24 steps", () => {
    const longTime = Array.from({ length: 48 }, (_, i) => `t${i}`);
    const longModels: ModelForecast[] = [
      { model: ForecastModel.GFS, temperature_2m: longTime.map((_, i) => i), precipitation: longTime.map(() => 0) },
    ];
    const { rows } = prepareModelComparisonData(longModels, longTime);
    expect(rows).toHaveLength(24);
  });

  it("coerces missing temps to null", () => {
    const { rows } = prepareModelComparisonData(
      [{ model: ForecastModel.GFS, temperature_2m: [20], precipitation: [0] }],
      ["t0", "t1"],
    );
    expect(rows[1][ForecastModel.GFS]).toBeNull();
  });
});

describe("model colour tokens", () => {
  it("every comparison model has a distinct chart token and swatch class", () => {
    const colors = new Set(Object.values(MODEL_COLORS));
    expect(colors.size).toBe(Object.keys(MODEL_COLORS).length);
    for (const key of Object.keys(MODEL_COLORS)) {
      expect(MODEL_SWATCH_CLASS[key]).toContain("bg-[var(--chart-");
    }
  });
});