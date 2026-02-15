"use client";

import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";
import { uvLevel } from "@/lib/weather";

interface UVCloudChartProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>[];
  labelKey?: string;
  aspect?: string;
  tooltipTitle?: (label: string) => string;
  xTickFormat?: (label: string, index: number) => string;
  maxTicksLimit?: number;
}

const SERIES: SeriesConfig[] = [
  { key: "uvIndex", label: "UV Index", color: "var(--chart-3)", type: "bar", opacity: 0.5, yAxisID: "uv", order: 2 },
  { key: "cloudCover", label: "Cloud Cover", color: "var(--chart-2)", yAxisID: "cloud", order: 1 },
];

const Y_AXES = {
  uv: { position: "left" as const, min: 0, max: 12 },
  cloud: { position: "right" as const, min: 0, max: 100, format: (v: number) => `${v}%` },
};

/**
 * Combined UV index bars + cloud cover line chart with dual Y axes.
 * Used by HistoryDashboard.
 */
export function UVCloudChart({
  data,
  labelKey = "date",
  aspect,
  tooltipTitle,
  xTickFormat,
  maxTicksLimit = 10,
}: UVCloudChartProps) {
  return (
    <TimeSeriesChart
      data={data}
      labelKey={labelKey}
      series={SERIES}
      yAxes={Y_AXES}
      tooltipLabel={(label, value) =>
        label === "UV Index" ? `UV ${value} (${uvLevel(value).label})` : `${value}%`
      }
      tooltipTitle={tooltipTitle}
      xTickFormat={xTickFormat}
      maxTicksLimit={maxTicksLimit}
      aspect={aspect}
    />
  );
}
