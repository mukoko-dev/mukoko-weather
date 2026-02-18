"use client";

import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";

interface ThunderstormChartProps {
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
  { key: "thunderstorm", label: "Thunderstorm Risk", color: "var(--chart-4)", type: "bar", opacity: 0.5 },
];

const Y_AXES = { y: { min: 0, max: 100, format: (v: number) => `${v}%` } };

/**
 * Thunderstorm probability trend chart — shows lightning/storm risk over time.
 * >20% = monitor, >40% = sports unsafe, >50% = mining/travel unsafe.
 * Used by HistoryDashboard insights section.
 */
export function ThunderstormChart({
  data,
  labelKey = "date",
  aspect = "aspect-[16/5]",
  showDots,
  tooltipTitle,
  xTickFormat,
  maxTicksLimit = 10,
}: ThunderstormChartProps) {
  return (
    <TimeSeriesChart
      data={data}
      labelKey={labelKey}
      series={SERIES}
      yAxes={Y_AXES}
      tooltipLabel={(_label, value) => `${value}%`}
      tooltipTitle={tooltipTitle}
      xTickFormat={xTickFormat}
      maxTicksLimit={maxTicksLimit}
      aspect={aspect}
      showDots={showDots}
    />
  );
}
