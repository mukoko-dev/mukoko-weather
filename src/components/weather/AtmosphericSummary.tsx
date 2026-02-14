"use client";

import Link from "next/link";
import type { CurrentWeather } from "@/lib/weather";
import { windDirection, uvLevel } from "@/lib/weather";
import {
  DropletIcon,
  CloudIcon,
  WindIcon,
  GaugeIcon,
  SunIcon,
  EyeIcon,
} from "@/lib/weather-icons";

interface Props {
  current: CurrentWeather;
}

function humidityLabel(h: number): string {
  if (h <= 30) return "Dry";
  if (h <= 60) return "Comfortable";
  if (h <= 80) return "Humid";
  return "Very humid";
}

function pressureLabel(p: number): string {
  if (p < 1000) return "Low";
  if (p <= 1020) return "Normal";
  return "High";
}

function cloudLabel(c: number): string {
  if (c <= 10) return "Clear";
  if (c <= 30) return "Mostly clear";
  if (c <= 70) return "Partly cloudy";
  if (c <= 90) return "Mostly cloudy";
  return "Overcast";
}

interface MetricCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  context: string;
  contextColor?: string;
}

function MetricCard({ icon, label, value, context, contextColor = "text-text-tertiary" }: MetricCardProps) {
  return (
    <div className="flex items-start gap-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm">
      <span className="mt-0.5 text-text-tertiary" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-sm text-text-secondary">{label}</p>
        <p className="text-lg font-semibold text-text-primary">{value}</p>
        <p className={`text-sm ${contextColor}`}>{context}</p>
      </div>
    </div>
  );
}

export function AtmosphericSummary({ current }: Props) {
  const uv = uvLevel(current.uv_index);
  const wind = Math.round(current.wind_speed_10m);
  const gusts = Math.round(current.wind_gusts_10m);

  return (
    <section aria-labelledby="atmospheric-heading">
      <div className="mb-3 flex items-center justify-between">
        <h2
          id="atmospheric-heading"
          className="text-lg font-semibold text-text-primary font-heading"
        >
          Conditions
        </h2>
        <Link
          href="/history"
          className="text-sm font-medium text-primary transition-colors hover:text-primary/80"
        >
          24h trends →
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <MetricCard
          icon={<DropletIcon size={20} />}
          label="Humidity"
          value={`${current.relative_humidity_2m}%`}
          context={humidityLabel(current.relative_humidity_2m)}
        />
        <MetricCard
          icon={<CloudIcon size={20} />}
          label="Cloud Cover"
          value={`${current.cloud_cover}%`}
          context={cloudLabel(current.cloud_cover)}
        />
        <MetricCard
          icon={<WindIcon size={20} />}
          label="Wind"
          value={`${wind} km/h`}
          context={`Gusts ${gusts} km/h · ${windDirection(current.wind_direction_10m)}`}
        />
        <MetricCard
          icon={<GaugeIcon size={20} />}
          label="Pressure"
          value={`${Math.round(current.surface_pressure)} hPa`}
          context={pressureLabel(current.surface_pressure)}
        />
        <MetricCard
          icon={<SunIcon size={20} />}
          label="UV Index"
          value={`${Math.round(current.uv_index)}`}
          context={uv.label}
          contextColor={uv.color}
        />
        <MetricCard
          icon={<EyeIcon size={20} />}
          label="Feels Like"
          value={`${Math.round(current.apparent_temperature)}°`}
          context={current.apparent_temperature < current.temperature_2m ? "Cooler than actual" : current.apparent_temperature > current.temperature_2m ? "Warmer than actual" : "Same as actual"}
        />
      </div>
    </section>
  );
}
