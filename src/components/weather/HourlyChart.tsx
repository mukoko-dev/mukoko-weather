"use client";

import { useMemo, useSyncExternalStore } from "react";
import { CanvasChart, resolveColor, type ChartConfig } from "@/components/ui/chart";
import type { ChartData, ChartOptions } from "chart.js";
import type { HourlyWeather } from "@/lib/weather";

interface Props {
  hourly: HourlyWeather;
}

export interface HourlyDataPoint {
  label: string;
  temp: number;
  feelsLike: number;
  rain: number;
}

/** Prepare 24-hour data slice starting from the current hour */
export function prepareHourlyData(hourly: HourlyWeather): HourlyDataPoint[] {
  const now = new Date();
  const currentHour = now.getHours();
  const startIndex = hourly.time.findIndex(
    (t) =>
      new Date(t).getHours() >= currentHour &&
      new Date(t).getDate() === now.getDate(),
  );
  const start = startIndex >= 0 ? startIndex : 0;

  const points: HourlyDataPoint[] = [];
  for (let i = 0; i < 24 && start + i < hourly.time.length; i++) {
    const idx = start + i;
    const date = new Date(hourly.time[idx]);
    points.push({
      label:
        i === 0
          ? "Now"
          : date.toLocaleTimeString("en-ZW", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }),
      temp: Math.round(hourly.temperature_2m[idx]),
      feelsLike: Math.round(hourly.apparent_temperature[idx]),
      rain: hourly.precipitation_probability[idx],
    });
  }
  return points;
}

const chartConfig = {
  temp: {
    label: "Temperature",
    color: "var(--chart-1)",
  },
  feelsLike: {
    label: "Feels Like",
    color: "var(--chart-3)",
  },
  rain: {
    label: "Rain %",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

export function HourlyChart({ hourly }: Props) {
  const hydrated = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  if (!hydrated) {
    return (
      <div className="mt-4 mb-2 aspect-[16/5] w-full animate-pulse rounded bg-text-tertiary/10" />
    );
  }

  return <HourlyChartInner hourly={hourly} />;
}

function HourlyChartInner({ hourly }: Props) {
  const data = prepareHourlyData(hourly);

  const allTemps = data.length >= 2
    ? data.flatMap((d) => [d.temp, d.feelsLike])
    : [0];
  const minTemp = Math.min(...allTemps) - 2;
  const maxTemp = Math.max(...allTemps) + 2;

  const tempColor = resolveColor("var(--chart-1)");
  const feelsLikeColor = resolveColor("var(--chart-3)");
  const rainColor = resolveColor("var(--chart-2)");
  const gridColor = resolveColor("var(--color-text-tertiary)");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartData: ChartData<any> = useMemo(
    () => ({
      labels: data.map((d) => d.label),
      datasets: [
        {
          type: "line" as const,
          label: "Temperature",
          data: data.map((d) => d.temp),
          borderColor: tempColor,
          backgroundColor: tempColor + "1a",
          borderWidth: 2.5,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHitRadius: 8,
          yAxisID: "y",
          order: 1,
        },
        {
          type: "line" as const,
          label: "Feels Like",
          data: data.map((d) => d.feelsLike),
          borderColor: feelsLikeColor,
          borderWidth: 1.5,
          borderDash: [4, 3],
          fill: false,
          tension: 0.4,
          pointRadius: 0,
          pointHitRadius: 8,
          yAxisID: "y",
          order: 2,
        },
        {
          type: "bar" as const,
          label: "Rain %",
          data: data.map((d) => d.rain),
          backgroundColor: rainColor + "59",
          borderRadius: 2,
          yAxisID: "rain",
          order: 3,
        },
      ],
    }),
    [data, tempColor, feelsLikeColor, rainColor],
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartOptions: ChartOptions<any> = useMemo(
    () => ({
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: gridColor,
            font: { size: 11 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 8,
          },
          border: { display: false },
        },
        y: {
          min: minTemp,
          max: maxTemp,
          grid: {
            color: gridColor + "26",
            drawTicks: false,
          },
          ticks: {
            color: gridColor,
            font: { size: 11 },
            callback: (v: string | number) => `${v}°`,
          },
          border: { display: false },
        },
        rain: {
          position: "right" as const,
          min: 0,
          max: 100,
          display: false,
        },
      },
      plugins: {
        tooltip: {
          callbacks: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            label: (ctx: any) => {
              const label = ctx.dataset.label || "";
              if (label === "Rain %") return `${label}: ${ctx.parsed.y}%`;
              return `${label}: ${ctx.parsed.y}°C`;
            },
          },
        },
      },
    }),
    [gridColor, minTemp, maxTemp],
  );

  if (data.length < 2) return null;

  return (
    <div className="mt-4 mb-2">
      <CanvasChart
        type="bar"
        data={chartData}
        options={chartOptions}
        config={chartConfig}
        className="aspect-[2/1] sm:aspect-[16/5] w-full"
      />
    </div>
  );
}
