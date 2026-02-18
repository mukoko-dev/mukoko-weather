"use client";

import { useMemo } from "react";
import { TimeSeriesChart, type SeriesConfig } from "./charts/TimeSeriesChart";
import type { DailyWeather } from "@/lib/weather";

interface Props {
  daily: DailyWeather;
}

export interface DailyDataPoint {
  day: string;
  high: number;
  low: number;
  feelsHigh: number;
  feelsLow: number;
  range: [number, number];
  rain: number;
}

/** Prepare 7-day data for the chart */
export function prepareDailyData(daily: DailyWeather): DailyDataPoint[] {
  return daily.time.map((date, i) => {
    const d = new Date(date);
    const dayName =
      i === 0
        ? "Today"
        : d.toLocaleDateString("en-ZW", { weekday: "short" });
    const high = Math.round(daily.temperature_2m_max[i]);
    const low = Math.round(daily.temperature_2m_min[i]);
    return {
      day: dayName,
      high,
      low,
      feelsHigh: Math.round(daily.apparent_temperature_max[i]),
      feelsLow: Math.round(daily.apparent_temperature_min[i]),
      range: [low, high],
      rain: daily.precipitation_probability_max[i],
    };
  });
}

const SERIES: SeriesConfig[] = [
  { key: "high", label: "High", color: "var(--chart-1)", fill: true, order: 1, showDots: true },
  { key: "low", label: "Low", color: "var(--chart-2)", fill: true, dashed: true, order: 2, showDots: true },
  { key: "feelsHigh", label: "Feels High", color: "var(--chart-3)", dashed: true, order: 3 },
  { key: "feelsLow", label: "Feels Low", color: "var(--chart-4)", dashed: true, order: 4 },
];

export function DailyChart({ daily }: Props) {
  const data = useMemo(() => prepareDailyData(daily), [daily]);

  if (data.length < 2) return null;

  // Compute dynamic y-axis range from all temperature data
  const allTemps = data.flatMap((d) => [d.high, d.low, d.feelsHigh, d.feelsLow]);
  const minTemp = Math.min(...allTemps) - 2;
  const maxTemp = Math.max(...allTemps) + 2;

  const yAxes = {
    y: {
      position: "left" as const,
      min: minTemp,
      max: maxTemp,
      format: (v: number) => `${v}°`,
    },
  };

  return (
    <div className="mt-4 mb-2">
      <TimeSeriesChart
        data={data}
        labelKey="day"
        series={SERIES}
        yAxes={yAxes}
        tooltipLabel={(label, value) => `${label}: ${value}°C`}
        aspect="aspect-[4/3] sm:aspect-[16/7]"
        showDots
      />
    </div>
  );
}
