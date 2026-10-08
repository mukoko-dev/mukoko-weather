"use client";

import { useMemo } from "react";
import { TimeSeriesChart, type SeriesConfig } from "./charts/TimeSeriesChart";
import type { HourlyWeather } from "@/lib/weather";
import {
  currentHourIndex,
  locationClockLabel,
  resolveOffsetSeconds,
} from "@/lib/location-time";

interface Props {
  hourly: HourlyWeather;
  /** The location's UTC offset (payload `utc_offset_seconds`). */
  utcOffsetSeconds?: number;
}

export interface HourlyDataPoint {
  label: string;
  temp: number;
  feelsLike: number;
  rain: number;
}

/** Prepare 24-hour data slice starting from the current hour */
export function prepareHourlyData(
  hourly: HourlyWeather,
  offsetSeconds?: number | null,
  now: Date = new Date(),
): HourlyDataPoint[] {
  // The LOCATION's current hour and labels — never the viewer's clock.
  const offset = resolveOffsetSeconds(offsetSeconds, now);
  const start = currentHourIndex(hourly.time, offset, now);

  const points: HourlyDataPoint[] = [];
  for (let i = 0; i < 24 && start + i < hourly.time.length; i++) {
    const idx = start + i;
    points.push({
      label:
        i === 0
          ? "Now"
          : locationClockLabel(hourly.time[idx], offset),
      temp: Math.round(hourly.temperature_2m[idx]),
      feelsLike: Math.round(hourly.apparent_temperature[idx]),
      rain: hourly.precipitation_probability[idx],
    });
  }
  return points;
}

const SERIES: SeriesConfig[] = [
  {
    key: "temp",
    label: "Temperature",
    color: "var(--chart-1)",
    fill: true,
    order: 1,
  },
  {
    key: "feelsLike",
    label: "Feels Like",
    color: "var(--chart-3)",
    dashed: true,
    order: 2,
  },
  {
    key: "rain",
    label: "Rain %",
    color: "var(--chart-2)",
    type: "bar",
    opacity: 0.35,
    yAxisID: "rain",
    order: 3,
  },
];

const Y_AXES = {
  y: { position: "left" as const, format: (v: number) => `${v}°` },
  rain: { position: "right" as const, min: 0, max: 100, display: false },
};

export function HourlyChart({ hourly, utcOffsetSeconds }: Props) {
  const data = useMemo(
    () => prepareHourlyData(hourly, utcOffsetSeconds),
    [hourly, utcOffsetSeconds],
  );

  if (data.length < 2) return null;

  // Compute dynamic y-axis range from temperature data
  const allTemps = data.flatMap((d) => [d.temp, d.feelsLike]);
  const minTemp = Math.min(...allTemps) - 2;
  const maxTemp = Math.max(...allTemps) + 2;

  const yAxes = {
    ...Y_AXES,
    y: { ...Y_AXES.y, min: minTemp, max: maxTemp },
  };

  return (
    <div className="mt-4 mb-2">
      <TimeSeriesChart
        data={data}
        labelKey="label"
        series={SERIES}
        yAxes={yAxes}
        tooltipLabel={(label, value) =>
          label === "Rain %" ? `${value}%` : `${label}: ${value}°C`
        }
        aspect="aspect-[2/1] sm:aspect-[16/5]"
      />
    </div>
  );
}
