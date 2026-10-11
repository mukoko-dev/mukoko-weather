"use client";

import type { AgriChartRow } from "@/lib/agriculture";
import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";

interface SoilMoistureChartProps {
  data: AgriChartRow[];
  labelKey?: string;
  aspect?: string;
  maxTicksLimit?: number;
}

const SERIES: SeriesConfig[] = [
  { key: "sm0to1", label: "0–1 cm", color: "var(--chart-5)" },
  { key: "sm1to3", label: "1–3 cm", color: "var(--chart-4)" },
  { key: "sm3to9", label: "3–9 cm", color: "var(--color-mineral-malachite)" },
  { key: "sm9to27", label: "9–27 cm", color: "var(--chart-2)", dashed: true },
  { key: "sm27to81", label: "27–81 cm", color: "var(--chart-6)", dashed: true },
];

const Y_AXES = { y: { min: 0, format: (v: number) => `${v}%` } };

/**
 * Volumetric soil water by depth (% of soil volume). Topsoil (solid) dries
 * and wets fast; the root zone (dashed) moves slowly. Used by the agriculture
 * insights page.
 */
export function SoilMoistureChart({
  data,
  labelKey = "date",
  aspect = "aspect-[16/7] sm:aspect-[16/5]",
  maxTicksLimit = 8,
}: SoilMoistureChartProps) {
  return (
    <TimeSeriesChart
      data={data}
      labelKey={labelKey}
      series={SERIES}
      yAxes={Y_AXES}
      tooltipLabel={(label, value) => `${label}: ${Math.round(value)}%`}
      maxTicksLimit={maxTicksLimit}
      aspect={aspect}
    />
  );
}
