"use client";

import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";

interface MonthlyNormalsChartProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>[];
  mode: "temperature" | "precipitation";
  labelKey?: string;
  aspect?: string;
}

const TEMPERATURE: SeriesConfig[] = [
  { key: "meanHighC", label: "Average high", color: "var(--chart-1)" },
  {
    key: "meanLowC",
    label: "Average low",
    color: "var(--chart-2)",
    dashed: true,
  },
];

const PRECIPITATION: SeriesConfig[] = [
  {
    key: "precipMm",
    label: "Average rainfall",
    color: "var(--chart-2)",
    type: "bar",
    opacity: 0.6,
  },
];

const TEMPERATURE_AXES = { y: { format: (v: number) => `${v}°` } };
const PRECIPITATION_AXES = { y: { min: 0, format: (v: number) => `${v} mm` } };

/** The twelve monthly normals as lines (temperature) or bars (rainfall). */
export function MonthlyNormalsChart({
  data,
  mode,
  labelKey = "label",
  aspect = "aspect-[16/8]",
}: MonthlyNormalsChartProps) {
  const temperature = mode === "temperature";
  return (
    <TimeSeriesChart
      data={data}
      labelKey={labelKey}
      series={temperature ? TEMPERATURE : PRECIPITATION}
      yAxes={temperature ? TEMPERATURE_AXES : PRECIPITATION_AXES}
      tooltipLabel={(label, value) =>
        temperature ? `${label}: ${value}°` : `${value} mm`
      }
      maxTicksLimit={12}
      aspect={aspect}
    />
  );
}
