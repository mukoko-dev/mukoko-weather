"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { CurrentWeather } from "@/lib/weather";
import { windDirection, uvLevel } from "@/lib/weather";
import { humidityLabel, pressureLabel, cloudLabel, feelsLikeContext } from "@/lib/weather-labels";
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

// ── Gauge bar configurations ─────────────────────────────────────────────────
// Each metric gets a visual indicator bar showing where its value falls
// on a color-coded scale (green→yellow→orange→red).

interface GaugeConfig {
  /** Value as percentage of the gauge (0-100) */
  percent: number;
  /** Color class for the filled portion */
  colorClass: string;
  /** Track gradient classes for the background */
  trackClass?: string;
}

/** UV Index: 0–11+ scale, green→yellow→orange→red→purple */
function uvGauge(uv: number): GaugeConfig {
  const percent = Math.min((uv / 11) * 100, 100);
  if (uv <= 2) return { percent, colorClass: "bg-severity-low" };
  if (uv <= 5) return { percent, colorClass: "bg-severity-moderate" };
  if (uv <= 7) return { percent, colorClass: "bg-severity-high" };
  if (uv <= 10) return { percent, colorClass: "bg-severity-severe" };
  return { percent, colorClass: "bg-severity-extreme" };
}

/** Humidity: 0–100%, blue scale. Comfort zone is 30–60% */
function humidityGauge(h: number): GaugeConfig {
  const percent = Math.min(h, 100);
  if (h < 30) return { percent, colorClass: "bg-severity-moderate" };
  if (h <= 60) return { percent, colorClass: "bg-severity-low" };
  if (h <= 80) return { percent, colorClass: "bg-severity-moderate" };
  return { percent, colorClass: "bg-severity-high" };
}

/** Cloud cover: 0–100% */
function cloudGauge(c: number): GaugeConfig {
  const percent = Math.min(c, 100);
  if (c <= 25) return { percent, colorClass: "bg-severity-low" };
  if (c <= 50) return { percent, colorClass: "bg-severity-low" };
  if (c <= 75) return { percent, colorClass: "bg-severity-moderate" };
  return { percent, colorClass: "bg-severity-high" };
}

/** Wind speed: 0–80+ km/h scale */
function windGauge(speed: number): GaugeConfig {
  const percent = Math.min((speed / 80) * 100, 100);
  if (speed <= 19) return { percent, colorClass: "bg-severity-low" };
  if (speed <= 38) return { percent, colorClass: "bg-severity-moderate" };
  if (speed <= 61) return { percent, colorClass: "bg-severity-high" };
  return { percent, colorClass: "bg-severity-severe" };
}

/** Pressure: 980–1040 hPa range mapped to gauge */
function pressureGauge(p: number): GaugeConfig {
  const min = 980;
  const max = 1040;
  const clamped = Math.max(min, Math.min(p, max));
  const percent = ((clamped - min) / (max - min)) * 100;
  if (p < 1000) return { percent, colorClass: "bg-severity-moderate" };
  if (p <= 1020) return { percent, colorClass: "bg-severity-low" };
  return { percent, colorClass: "bg-severity-moderate" };
}

/** Feels-like difference from actual */
function feelsLikeGauge(feelsLike: number, actual: number): GaugeConfig {
  const diff = Math.abs(feelsLike - actual);
  // Gauge shows how different feels-like is from actual (0–15° range)
  const percent = Math.min((diff / 15) * 100, 100);
  if (diff <= 2) return { percent: Math.max(percent, 8), colorClass: "bg-severity-low" };
  if (diff <= 5) return { percent, colorClass: "bg-severity-moderate" };
  if (diff <= 10) return { percent, colorClass: "bg-severity-high" };
  return { percent, colorClass: "bg-severity-severe" };
}

// ── Gauge bar component ──────────────────────────────────────────────────────

function GaugeBar({ percent, colorClass }: GaugeConfig) {
  return (
    <div
      className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-text-tertiary/15"
      role="progressbar"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full transition-all duration-500 ${colorClass}`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

// ── Metric card with visual gauge ────────────────────────────────────────────

interface MetricCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  context: string;
  contextColor?: string;
  gauge: GaugeConfig;
}

function MetricCard({ icon, label, value, context, contextColor = "text-text-tertiary", gauge }: MetricCardProps) {
  return (
    <div className="flex flex-col rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-text-tertiary" aria-hidden="true">
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-sm text-text-secondary">{label}</p>
          <p className="text-lg font-semibold text-text-primary">{value}</p>
          <p className={`text-sm ${contextColor}`}>{context}</p>
        </div>
      </div>
      <GaugeBar {...gauge} />
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function AtmosphericSummary({ current }: Props) {
  const pathname = usePathname();
  const locationSlug = pathname?.split("/")[1] || "harare";
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
          href={`/${locationSlug}/atmosphere`}
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
          gauge={humidityGauge(current.relative_humidity_2m)}
        />
        <MetricCard
          icon={<CloudIcon size={20} />}
          label="Cloud Cover"
          value={`${current.cloud_cover}%`}
          context={cloudLabel(current.cloud_cover)}
          gauge={cloudGauge(current.cloud_cover)}
        />
        <MetricCard
          icon={<WindIcon size={20} />}
          label="Wind"
          value={`${wind} km/h`}
          context={`Gusts ${gusts} km/h · ${windDirection(current.wind_direction_10m)}`}
          gauge={windGauge(wind)}
        />
        <MetricCard
          icon={<GaugeIcon size={20} />}
          label="Pressure"
          value={`${Math.round(current.surface_pressure)} hPa`}
          context={pressureLabel(current.surface_pressure)}
          gauge={pressureGauge(current.surface_pressure)}
        />
        <MetricCard
          icon={<SunIcon size={20} />}
          label="UV Index"
          value={`${Math.round(current.uv_index)}`}
          context={uv.label}
          contextColor={uv.color}
          gauge={uvGauge(current.uv_index)}
        />
        <MetricCard
          icon={<EyeIcon size={20} />}
          label="Feels Like"
          value={`${Math.round(current.apparent_temperature)}°`}
          context={feelsLikeContext(current.apparent_temperature, current.temperature_2m)}
          gauge={feelsLikeGauge(current.apparent_temperature, current.temperature_2m)}
        />
      </div>
    </section>
  );
}
