"use client";

import { useMemo, useSyncExternalStore } from "react";
import { CanvasChart, resolveColor, type ChartConfig } from "@/components/ui/chart";
import type { ChartData, ChartOptions } from "chart.js";
import type { DailyWeather } from "@/lib/weather";

interface Props {
  daily: DailyWeather;
}

export interface DailyDataPoint {
  day: string;
  high: number;
  low: number;
  feelsHigh: number;
  feelsLow: number;
  range: [number, number];
  rain: number;
}

/** Prepare 7-day data for the chart */
export function prepareDailyData(daily: DailyWeather): DailyDataPoint[] {
  return daily.time.map((date, i) => {
    const d = new Date(date);
    const dayName =
      i === 0
        ? "Today"
        : d.toLocaleDateString("en-ZW", { weekday: "short" });
    const high = Math.round(daily.temperature_2m_max[i]);
    const low = Math.round(daily.temperature_2m_min[i]);
    return {
      day: dayName,
      high,
      low,
      feelsHigh: Math.round(daily.apparent_temperature_max[i]),
      feelsLow: Math.round(daily.apparent_temperature_min[i]),
      range: [low, high],
      rain: daily.precipitation_probability_max[i],
    };
  });
}

const chartConfig = {
  high: {
    label: "High",
    color: "var(--chart-1)",
  },
  low: {
    label: "Low",
    color: "var(--chart-2)",
  },
  feelsHigh: {
    label: "Feels High",
    color: "var(--chart-3)",
  },
  feelsLow: {
    label: "Feels Low",
    color: "var(--chart-4)",
  },
} satisfies ChartConfig;

const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

export function DailyChart({ daily }: Props) {
  const hydrated = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  if (!hydrated) {
    return (
      <div className="mt-4 mb-2 aspect-[16/7] w-full animate-pulse rounded bg-text-tertiary/10" />
    );
  }

  return <DailyChartInner daily={daily} />;
}

function DailyChartInner({ daily }: Props) {
  const data = prepareDailyData(daily);

  const allTemps = data.length >= 2 ? data.flatMap((d) => [d.high, d.low, d.feelsHigh, d.feelsLow]) : [0, 10];
  const minTemp = Math.min(...allTemps) - 2;
  const maxTemp = Math.max(...allTemps) + 2;

  const highColor = resolveColor("var(--chart-1)");
  const lowColor = resolveColor("var(--chart-2)");
  const feelsHighColor = resolveColor("var(--chart-3)");
  const feelsLowColor = resolveColor("var(--chart-4)");
  const gridColor = resolveColor("var(--color-text-tertiary)");

  const chartData: ChartData<"line"> = useMemo(
    () => ({
      labels: data.map((d) => d.day),
      datasets: [
        {
          label: "High",
          data: data.map((d) => d.high),
          borderColor: highColor,
          backgroundColor: highColor + "40",
          borderWidth: 2.5,
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointBackgroundColor: resolveColor("var(--color-surface-card)"),
          pointBorderWidth: 2,
          pointHitRadius: 10,
        },
        {
          label: "Low",
          data: data.map((d) => d.low),
          borderColor: lowColor,
          backgroundColor: lowColor + "26",
          borderWidth: 2,
          borderDash: [4, 3],
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointBackgroundColor: resolveColor("var(--color-surface-card)"),
          pointBorderWidth: 2,
          pointHitRadius: 10,
        },
        {
          label: "Feels High",
          data: data.map((d) => d.feelsHigh),
          borderColor: feelsHighColor,
          borderWidth: 1.5,
          borderDash: [4, 3],
          fill: false,
          tension: 0.4,
          pointRadius: 0,
          pointHitRadius: 8,
        },
        {
          label: "Feels Low",
          data: data.map((d) => d.feelsLow),
          borderColor: feelsLowColor,
          borderWidth: 1.5,
          borderDash: [4, 3],
          fill: false,
          tension: 0.4,
          pointRadius: 0,
          pointHitRadius: 8,
        },
      ],
    }),
    [data, highColor, lowColor, feelsHighColor, feelsLowColor],
  );

  const chartOptions: ChartOptions<"line"> = useMemo(
    () => ({
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: gridColor,
            font: { size: 11 },
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
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const labels: Record<string, string> = {
                High: "High",
                Low: "Low",
                "Feels High": "Feels High",
                "Feels Low": "Feels Low",
              };
              return `${labels[ctx.dataset.label!] ?? ctx.dataset.label}: ${ctx.parsed.y}°C`;
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
        type="line"
        data={chartData}
        options={chartOptions}
        config={chartConfig}
        className="aspect-[16/7] w-full"
      />
    </div>
  );
}
