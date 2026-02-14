"use client";

import { Area, CartesianGrid, XAxis, YAxis, Line, Bar, ComposedChart } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { HourlyWeather } from "@/lib/weather";

interface Props {
  hourly: HourlyWeather;
}

interface AtmosphericDataPoint {
  label: string;
  humidity: number;
  cloudCover: number;
  pressure: number;
  windSpeed: number;
  windGusts: number;
  uvIndex: number;
}

/** Prepare 24-hour atmospheric data slice starting from the current hour */
export function prepareAtmosphericData(hourly: HourlyWeather): AtmosphericDataPoint[] {
  const now = new Date();
  const currentHour = now.getHours();
  const startIndex = hourly.time.findIndex(
    (t) =>
      new Date(t).getHours() >= currentHour &&
      new Date(t).getDate() === now.getDate(),
  );
  const start = startIndex >= 0 ? startIndex : 0;

  const points: AtmosphericDataPoint[] = [];
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
      humidity: hourly.relative_humidity_2m[idx],
      cloudCover: hourly.cloud_cover[idx],
      pressure: Math.round(hourly.surface_pressure[idx]),
      windSpeed: Math.round(hourly.wind_speed_10m[idx]),
      windGusts: Math.round(hourly.wind_gusts_10m[idx]),
      uvIndex: hourly.uv_index[idx],
    });
  }
  return points;
}

// ── Humidity & Cloud Cover Chart ──────────────────────────────────────────

const humidityCloudConfig = {
  humidity: {
    label: "Humidity",
    color: "var(--chart-2)",
  },
  cloudCover: {
    label: "Cloud Cover",
    color: "var(--chart-5)",
  },
} satisfies ChartConfig;

function HumidityCloudChart({ data }: { data: AtmosphericDataPoint[] }) {
  return (
    <ChartContainer config={humidityCloudConfig} className="aspect-[16/5] w-full">
      <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -20 }}>
        <defs>
          <linearGradient id="humidityGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-humidity)" stopOpacity={0.3} />
            <stop offset="100%" stopColor="var(--color-humidity)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-text-tertiary)" strokeOpacity={0.15} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} interval={3} tick={{ fill: "var(--color-text-tertiary)" }} />
        <YAxis domain={[0, 100]} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}%`} fontSize={11} tick={{ fill: "var(--color-text-tertiary)" }} width={40} />
        <ChartTooltip content={<ChartTooltipContent formatter={(value) => `${value}%`} />} />
        <Area type="monotone" dataKey="humidity" stroke="var(--color-humidity)" strokeWidth={2} fill="url(#humidityGradient)" dot={false} activeDot={false} />
        <Line type="monotone" dataKey="cloudCover" stroke="var(--color-cloudCover)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} activeDot={false} />
      </ComposedChart>
    </ChartContainer>
  );
}

// ── Wind Speed & Gusts Chart ──────────────────────────────────────────────

const windConfig = {
  windSpeed: {
    label: "Wind Speed",
    color: "var(--chart-1)",
  },
  windGusts: {
    label: "Wind Gusts",
    color: "var(--chart-4)",
  },
} satisfies ChartConfig;

function WindChart({ data }: { data: AtmosphericDataPoint[] }) {
  const allWind = data.flatMap((d) => [d.windSpeed, d.windGusts]);
  const maxWind = (allWind.length > 0 ? Math.max(...allWind) : 20) + 5;

  return (
    <ChartContainer config={windConfig} className="aspect-[16/5] w-full">
      <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -20 }}>
        <defs>
          <linearGradient id="windSpeedGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-windSpeed)" stopOpacity={0.25} />
            <stop offset="100%" stopColor="var(--color-windSpeed)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-text-tertiary)" strokeOpacity={0.15} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} interval={3} tick={{ fill: "var(--color-text-tertiary)" }} />
        <YAxis domain={[0, maxWind]} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}`} fontSize={11} tick={{ fill: "var(--color-text-tertiary)" }} width={40} />
        <ChartTooltip content={<ChartTooltipContent formatter={(value) => `${value} km/h`} />} />
        <Area type="monotone" dataKey="windSpeed" stroke="var(--color-windSpeed)" strokeWidth={2} fill="url(#windSpeedGradient)" dot={false} activeDot={false} />
        <Line type="monotone" dataKey="windGusts" stroke="var(--color-windGusts)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} activeDot={false} />
      </ComposedChart>
    </ChartContainer>
  );
}

// ── Pressure Chart ────────────────────────────────────────────────────────

const pressureConfig = {
  pressure: {
    label: "Pressure",
    color: "var(--chart-3)",
  },
} satisfies ChartConfig;

function PressureChart({ data }: { data: AtmosphericDataPoint[] }) {
  const pressures = data.map((d) => d.pressure);
  const minP = (pressures.length > 0 ? Math.min(...pressures) : 1010) - 2;
  const maxP = (pressures.length > 0 ? Math.max(...pressures) : 1020) + 2;

  return (
    <ChartContainer config={pressureConfig} className="aspect-[16/5] w-full">
      <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -20 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-text-tertiary)" strokeOpacity={0.15} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} interval={3} tick={{ fill: "var(--color-text-tertiary)" }} />
        <YAxis domain={[minP, maxP]} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}`} fontSize={11} tick={{ fill: "var(--color-text-tertiary)" }} width={48} />
        <ChartTooltip content={<ChartTooltipContent formatter={(value) => `${value} hPa`} />} />
        <Line type="monotone" dataKey="pressure" stroke="var(--color-pressure)" strokeWidth={2} dot={false} activeDot={false} />
      </ComposedChart>
    </ChartContainer>
  );
}

// ── UV Index Chart ────────────────────────────────────────────────────────

const uvConfig = {
  uvIndex: {
    label: "UV Index",
    color: "var(--chart-4)",
  },
} satisfies ChartConfig;

function UVChart({ data }: { data: AtmosphericDataPoint[] }) {
  const maxUV = Math.max(...data.map((d) => d.uvIndex), 11) + 1;

  return (
    <ChartContainer config={uvConfig} className="aspect-[16/5] w-full">
      <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -20 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-text-tertiary)" strokeOpacity={0.15} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} interval={3} tick={{ fill: "var(--color-text-tertiary)" }} />
        <YAxis domain={[0, maxUV]} tickLine={false} axisLine={false} fontSize={11} tick={{ fill: "var(--color-text-tertiary)" }} width={32} />
        <ChartTooltip content={<ChartTooltipContent formatter={(value) => `${value}`} />} />
        <Bar dataKey="uvIndex" fill="var(--color-uvIndex)" fillOpacity={0.6} radius={[2, 2, 0, 0]} />
      </ComposedChart>
    </ChartContainer>
  );
}

// ── Main Component ────────────────────────────────────────────────────────

export function AtmosphericDetails({ hourly }: Props) {
  const data = prepareAtmosphericData(hourly);
  if (data.length < 2) return null;

  return (
    <section aria-labelledby="atmospheric-details-heading">
      <div className="rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm sm:p-6">
        <h2 id="atmospheric-details-heading" className="text-lg font-semibold text-text-primary font-heading">
          Atmospheric Details
        </h2>
        <p className="mt-1 text-sm text-text-tertiary">24-hour hourly trends</p>

        <div className="mt-4 space-y-6">
          {/* Humidity & Cloud Cover */}
          <div>
            <h3 className="mb-2 text-sm font-medium text-text-secondary">Humidity & Cloud Cover</h3>
            <HumidityCloudChart data={data} />
          </div>

          {/* Wind Speed & Gusts */}
          <div>
            <h3 className="mb-2 text-sm font-medium text-text-secondary">Wind Speed & Gusts</h3>
            <WindChart data={data} />
          </div>

          {/* Barometric Pressure */}
          <div>
            <h3 className="mb-2 text-sm font-medium text-text-secondary">Barometric Pressure</h3>
            <PressureChart data={data} />
          </div>

          {/* UV Index */}
          <div>
            <h3 className="mb-2 text-sm font-medium text-text-secondary">UV Index</h3>
            <UVChart data={data} />
          </div>
        </div>
      </div>
    </section>
  );
}
