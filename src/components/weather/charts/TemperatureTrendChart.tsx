"use client";

import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";

interface TemperatureTrendChartProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>[];
  labelKey?: string;
  aspect?: string;
  showDots?: boolean;
  tooltipTitle?: (label: string) => string;
  xTickFormat?: (label: string, index: number) => string;
  maxTicksLimit?: number;
}

const SERIES: SeriesConfig[] = [
  { key: "tempHigh", label: "High", color: "var(--chart-1)", fill: true },
  { key: "tempLow", label: "Low", color: "var(--chart-2)", fill: true, dashed: true, opacity: 0.15 },
  { key: "feelsLikeHigh", label: "Feels High", color: "var(--chart-3)", dashed: true },
  { key: "feelsLikeLow", label: "Feels Low", color: "var(--chart-4)", dashed: true },
];

const Y_AXES = { y: { format: (v: number) => `${v}°` } };

/**
 * Temperature trend chart: high/low areas + feels-like dashed lines.
 * Used by HistoryDashboard for multi-day temperature visualization.
 */
export function TemperatureTrendChart({
  data,
  labelKey = "date",
  aspect = "aspect-[16/6]",
  showDots,
  tooltipTitle,
  xTickFormat,
  maxTicksLimit = 10,
}: TemperatureTrendChartProps) {
  return (
    <TimeSeriesChart
      data={data}
      labelKey={labelKey}
      series={SERIES}
      yAxes={Y_AXES}
      tooltipLabel={(label, value) => `${label}: ${value}°C`}
      tooltipTitle={tooltipTitle}
      xTickFormat={xTickFormat}
      maxTicksLimit={maxTicksLimit}
      aspect={aspect}
      showDots={showDots}
    />
  );
}
