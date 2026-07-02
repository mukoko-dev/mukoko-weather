"use client";

import { useMemo } from "react";
import { TimeSeriesChart, type SeriesConfig } from "./charts/TimeSeriesChart";
import type { MinutelyData } from "@/lib/weather";

/**
 * Next-hour precipitation nowcast — a compact "will it rain soon?" panel.
 *
 * Renders 4 × 15-minute rain bars (Now / +15 / +30 / +45) plus a short
 * plain-language summary ("Rain starting in ~30 min"). Data comes from
 * Open-Meteo's `minutely_15` block. Colours resolve from globals.css tokens.
 */

/** Precipitation (mm/15-min) above which we consider it "raining". */
const RAIN_THRESHOLD_MM = 0.1;

const STEP_LABELS = ["Now", "+15", "+30", "+45"];

const SERIES: SeriesConfig[] = [
  { key: "precip", label: "Rain", color: "var(--color-rain)", type: "bar", opacity: 0.75 },
];

/**
 * Produce a plain-language summary of the next-hour precipitation.
 * Exported for testing.
 */
export function nowcastSummary(minutely: MinutelyData): string {
  const precip = minutely.precipitation ?? [];
  if (precip.length === 0) return "No nowcast data available.";

  const firstWetIndex = precip.findIndex((p) => (p ?? 0) >= RAIN_THRESHOLD_MM);

  if (firstWetIndex === -1) {
    return "No rain expected in the next hour.";
  }
  if (firstWetIndex === 0) {
    const stillRaining = precip.every((p) => (p ?? 0) >= RAIN_THRESHOLD_MM);
    return stillRaining
      ? "Rain is falling and continues through the next hour."
      : "Rain is falling now — easing within the hour.";
  }
  const minutes = firstWetIndex * 15;
  return `Rain starting in ~${minutes} min.`;
}

interface MinutelyNowcastProps {
  minutely: MinutelyData;
}

export function MinutelyNowcast({ minutely }: MinutelyNowcastProps) {
  const rows = useMemo(() => {
    const precip = minutely.precipitation ?? [];
    return precip.slice(0, 4).map((p, i) => ({
      t: STEP_LABELS[i] ?? `+${i * 15}`,
      precip: p ?? 0,
    }));
  }, [minutely]);

  const summary = useMemo(() => nowcastSummary(minutely), [minutely]);

  if (rows.length === 0) return null;

  const totalPrecip = rows.reduce((sum, r) => sum + (r.precip ?? 0), 0);
  const hasRain = totalPrecip > 0;

  return (
    <section aria-labelledby="nowcast-heading" className="baobab">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 id="nowcast-heading" className="giraffe">
          Next hour
        </h2>
        <span className="dove">15-min precipitation</span>
      </div>
      <p className="gazelle mb-3">{summary}</p>
      {hasRain ? (
        <TimeSeriesChart
          data={rows}
          labelKey="t"
          series={SERIES}
          yAxes={{ y: { min: 0, format: (v: number) => `${v}mm` } }}
          tooltipLabel={(_label, value) => `${value.toFixed(1)} mm`}
          maxTicksLimit={4}
          aspect="aspect-[16/5]"
        />
      ) : (
        <div
          className="flex items-end gap-2"
          role="img"
          aria-label="No precipitation expected in the next hour"
        >
          {rows.map((r) => (
            <div key={r.t} className="flex flex-1 flex-col items-center gap-1">
              <div className="h-8 w-full rounded-sm bg-surface-base" aria-hidden="true" />
              <span className="text-sm text-text-tertiary">{r.t}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
