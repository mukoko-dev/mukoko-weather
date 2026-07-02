"use client";

import { useMemo } from "react";
import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";
import { FORECAST_MODEL_LABELS, ForecastModel, type ModelForecast } from "@/lib/weather";

/**
 * Windy-style multi-model comparison chart.
 *
 * Overlays each weather model's hourly temperature as a distinct
 * mineral-coloured line so users can see where the models agree and diverge.
 * Built on the shared {@link TimeSeriesChart} Canvas base — colours resolve
 * from globals.css mineral/chart tokens at render time (never hardcoded).
 */

/** Mineral colour token per model — distinct hues, Windy-style. */
export const MODEL_COLORS: Record<string, string> = {
  [ForecastModel.ECMWF]: "var(--chart-1)", // Tanzanite
  [ForecastModel.GFS]: "var(--chart-2)", // Cobalt
  [ForecastModel.ICON]: "var(--chart-3)", // Malachite
  [ForecastModel.MeteoFrance]: "var(--chart-4)", // Gold
  [ForecastModel.BestMatch]: "var(--chart-5)", // Terracotta
};

/** Static token-backed swatch classes (no dynamic class construction). */
export const MODEL_SWATCH_CLASS: Record<string, string> = {
  [ForecastModel.ECMWF]: "bg-[var(--chart-1)]",
  [ForecastModel.GFS]: "bg-[var(--chart-2)]",
  [ForecastModel.ICON]: "bg-[var(--chart-3)]",
  [ForecastModel.MeteoFrance]: "bg-[var(--chart-4)]",
  [ForecastModel.BestMatch]: "bg-[var(--chart-5)]",
};

const FALLBACK_COLOR = "var(--chart-5)";
const FALLBACK_SWATCH = "bg-[var(--chart-5)]";

/** Short label for a model id (agency acronym), falling back to the raw id. */
function modelShortLabel(model: string): string {
  const full = FORECAST_MODEL_LABELS[model as ForecastModel];
  if (!full) return model;
  // "ECMWF (Europe)" → "ECMWF"
  return full.split(" (")[0];
}

/**
 * Build the chart data rows + series config from the per-model series.
 * Exported for testing. Each row is `{ t, <model>: temp, ... }`.
 */
export function prepareModelComparisonData(
  models: ModelForecast[],
  time: string[],
): { rows: Record<string, string | number | null>[]; series: SeriesConfig[] } {
  const len = Math.min(24, time.length);
  const rows: Record<string, string | number | null>[] = [];
  for (let i = 0; i < len; i++) {
    const row: Record<string, string | number | null> = { t: time[i] };
    for (const m of models) {
      row[m.model] = m.temperature_2m[i] ?? null;
    }
    rows.push(row);
  }

  const series: SeriesConfig[] = models.map((m) => ({
    key: m.model,
    label: modelShortLabel(m.model),
    color: MODEL_COLORS[m.model] ?? FALLBACK_COLOR,
  }));

  return { rows, series };
}

function formatHour(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

interface ModelComparisonChartProps {
  models: ModelForecast[];
  /** Shared hourly time axis (ISO 8601) — Open-Meteo `models_time`. */
  time: string[];
  aspect?: string;
}

export function ModelComparisonChart({
  models,
  time,
  aspect = "aspect-[16/7]",
}: ModelComparisonChartProps) {
  const { rows, series } = useMemo(
    () => prepareModelComparisonData(models, time),
    [models, time],
  );

  if (rows.length === 0 || series.length === 0) return null;

  return (
    <section aria-labelledby="model-comparison-heading" className="baobab">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 id="model-comparison-heading" className="giraffe">
          Model comparison
        </h2>
        <span className="dove">Hourly temperature °C</span>
      </div>
      <p className="dove mb-3">
        How the major forecast models ({series.map((s) => s.label).join(", ")}) agree
        or diverge on the next 24 hours.
      </p>
      <TimeSeriesChart
        data={rows}
        labelKey="t"
        series={series}
        yAxes={{ y: { format: (v: number) => `${Math.round(v)}°` } }}
        tooltipLabel={(label, value) => `${label}: ${Math.round(value)}°C`}
        tooltipTitle={(label) => formatHour(String(label))}
        xTickFormat={(label) => formatHour(String(label))}
        aspect={aspect}
      />
      {/* Legend — mineral swatch per model */}
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Forecast models">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5 text-sm text-text-secondary">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${MODEL_SWATCH_CLASS[s.key] ?? FALLBACK_SWATCH}`}
              aria-hidden="true"
            />
            {s.label}
          </li>
        ))}
      </ul>
    </section>
  );
}
