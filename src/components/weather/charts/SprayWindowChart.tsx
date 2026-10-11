"use client";

import type { AgriChartRow } from "@/lib/agriculture";
import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";

interface SprayWindowChartProps {
  data: AgriChartRow[];
  labelKey?: string;
  aspect?: string;
  maxTicksLimit?: number;
}

const SERIES: SeriesConfig[] = [
  {
    key: "sprayHours",
    label: "Hours fit to spray",
    color: "var(--color-mineral-malachite)",
    type: "bar",
    opacity: 0.7,
    order: 2,
  },
  {
    key: "leafWetHours",
    label: "Leaf-wet hours",
    color: "var(--chart-2)",
    dashed: true,
    order: 1,
  },
];

const Y_AXES = { y: { min: 0, max: 24, format: (v: number) => `${v} h` } };

/**
 * Hours per day fit for spraying (light steady wind, mild, rain-free after)
 * against leaf-wet hours (disease pressure). Used by the agriculture page.
 */
export function SprayWindowChart({
  data,
  labelKey = "date",
  aspect = "aspect-[16/7] sm:aspect-[16/5]",
  maxTicksLimit = 8,
}: SprayWindowChartProps) {
  return (
    <TimeSeriesChart
      data={data}
      labelKey={labelKey}
      series={SERIES}
      yAxes={Y_AXES}
      tooltipLabel={(label, value) => `${label}: ${Math.round(value)} h`}
      maxTicksLimit={maxTicksLimit}
      aspect={aspect}
    />
  );
}
