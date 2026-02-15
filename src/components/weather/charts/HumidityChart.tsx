"use client";

import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";

interface HumidityChartProps {
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
  { key: "humidity", label: "Humidity", color: "var(--chart-2)", fill: true, opacity: 0.2 },
];

const Y_AXES = { y: { min: 0, max: 100, format: (v: number) => `${v}%` } };

/**
 * Single-series humidity area chart.
 * Used by HistoryDashboard.
 */
export function HumidityChart({
  data,
  labelKey = "date",
  aspect = "aspect-[16/4]",
  showDots,
  tooltipTitle,
  xTickFormat,
  maxTicksLimit = 10,
}: HumidityChartProps) {
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
