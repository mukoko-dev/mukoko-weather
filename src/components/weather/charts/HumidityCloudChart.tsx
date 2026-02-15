"use client";

import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";

interface HumidityCloudChartProps {
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
  { key: "humidity", label: "Humidity", color: "var(--chart-2)", fill: true, opacity: 0.3 },
  { key: "cloudCover", label: "Cloud Cover", color: "var(--chart-5)", dashed: true },
];

const Y_AXES = { y: { min: 0, max: 100, format: (v: number) => `${v}%` } };

/**
 * Humidity area + cloud cover dashed line chart.
 * Used by AtmosphericDetails (24h) and can be reused wherever
 * the data contains `humidity` and `cloudCover` numeric fields.
 */
export function HumidityCloudChart({
  data,
  labelKey = "label",
  aspect,
  showDots,
  tooltipTitle,
  xTickFormat,
  maxTicksLimit,
}: HumidityCloudChartProps) {
  return (
    <TimeSeriesChart
      data={data}
      labelKey={labelKey}
      series={SERIES}
      yAxes={Y_AXES}
      tooltipLabel={(label, value) => `${label}: ${value}%`}
      tooltipTitle={tooltipTitle}
      xTickFormat={xTickFormat}
      maxTicksLimit={maxTicksLimit}
      aspect={aspect}
      showDots={showDots}
    />
  );
}
