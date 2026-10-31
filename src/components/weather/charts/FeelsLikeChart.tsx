"use client";

import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";
import { WX_SERIES } from "@/lib/weather-scales";

interface FeelsLikeChartProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>[];
  labelKey?: string;
  aspect?: string;
  maxTicksLimit?: number;
}

const SERIES: SeriesConfig[] = [
  {
    key: "feelsLike",
    label: "Feels like",
    color: WX_SERIES.feels,
    fill: true,
    opacity: 0.12,
  },
  {
    key: "temperature",
    label: "Actual",
    color: WX_SERIES.temp,
    dashed: true,
  },
];

const Y_AXES = { y: { format: (v: number) => `${v}°` } };

/** Next-24-hour feels-like temperature against the actual air temperature. */
export function FeelsLikeChart({
  data,
  labelKey = "label",
  aspect,
  maxTicksLimit,
}: FeelsLikeChartProps) {
  return (
    <TimeSeriesChart
      data={data}
      labelKey={labelKey}
      series={SERIES}
      yAxes={Y_AXES}
      tooltipLabel={(label, value) => `${label}: ${value}°`}
      maxTicksLimit={maxTicksLimit}
      aspect={aspect}
    />
  );
}
