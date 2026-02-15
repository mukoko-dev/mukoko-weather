"use client";

import { useMemo } from "react";
import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";

interface UVIndexChartProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>[];
  labelKey?: string;
  aspect?: string;
  tooltipTitle?: (label: string) => string;
  xTickFormat?: (label: string, index: number) => string;
  maxTicksLimit?: number;
}

const SERIES: SeriesConfig[] = [
  { key: "uvIndex", label: "UV Index", color: "var(--chart-4)", type: "bar", opacity: 0.6 },
];

/**
 * UV index bar chart. Used by AtmosphericDetails.
 */
export function UVIndexChart({
  data,
  labelKey = "label",
  aspect,
  tooltipTitle,
  xTickFormat,
  maxTicksLimit,
}: UVIndexChartProps) {
  const yAxes = useMemo(() => {
    const maxUV = Math.max(...data.map((d) => Number(d.uvIndex) || 0), 11) + 1;
    return { y: { min: 0, max: maxUV } };
  }, [data]);

  return (
    <TimeSeriesChart
      data={data}
      labelKey={labelKey}
      series={SERIES}
      yAxes={yAxes}
      tooltipLabel={(_label, value) => `UV ${value}`}
      tooltipTitle={tooltipTitle}
      xTickFormat={xTickFormat}
      maxTicksLimit={maxTicksLimit}
      aspect={aspect}
    />
  );
}
