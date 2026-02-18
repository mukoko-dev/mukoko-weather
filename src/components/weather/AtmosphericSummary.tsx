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

// ── Gauge configurations ─────────────────────────────────────────────────────
// Each metric gets a radial arc gauge showing where its value falls
// on a severity-colored scale. The arc spans 270° (open at bottom).

interface GaugeConfig {
  /** Value as percentage of the gauge (0-100) */
  percent: number;
  /** CSS class for the stroke color of the filled arc */
  strokeClass: string;
}

/** UV Index: 0–11+ scale */
function uvGauge(uv: number): GaugeConfig {
  const percent = Math.min((uv / 11) * 100, 100);
  if (uv <= 2) return { percent, strokeClass: "stroke-severity-low" };
  if (uv <= 5) return { percent, strokeClass: "stroke-severity-moderate" };
  if (uv <= 7) return { percent, strokeClass: "stroke-severity-high" };
  if (uv <= 10) return { percent, strokeClass: "stroke-severity-severe" };
  return { percent, strokeClass: "stroke-severity-extreme" };
}

/** Humidity: 0–100%, comfort zone is 30–60% */
function humidityGauge(h: number): GaugeConfig {
  const percent = Math.min(h, 100);
  if (h < 30) return { percent, strokeClass: "stroke-severity-moderate" };
  if (h <= 60) return { percent, strokeClass: "stroke-severity-low" };
  if (h <= 80) return { percent, strokeClass: "stroke-severity-moderate" };
  return { percent, strokeClass: "stroke-severity-high" };
}

/** Cloud cover: 0–100% */
function cloudGauge(c: number): GaugeConfig {
  const percent = Math.min(c, 100);
  if (c <= 50) return { percent, strokeClass: "stroke-severity-low" };
  if (c <= 75) return { percent, strokeClass: "stroke-severity-moderate" };
  return { percent, strokeClass: "stroke-severity-high" };
}

/** Wind speed: 0–80+ km/h scale */
function windGauge(speed: number): GaugeConfig {
  const percent = Math.min((speed / 80) * 100, 100);
  if (speed <= 19) return { percent, strokeClass: "stroke-severity-low" };
  if (speed <= 38) return { percent, strokeClass: "stroke-severity-moderate" };
  if (speed <= 61) return { percent, strokeClass: "stroke-severity-high" };
  return { percent, strokeClass: "stroke-severity-severe" };
}

/** Pressure: 980–1040 hPa range mapped to gauge */
function pressureGauge(p: number): GaugeConfig {
  const min = 980;
  const max = 1040;
  const clamped = Math.max(min, Math.min(p, max));
  const percent = ((clamped - min) / (max - min)) * 100;
  if (p < 1000) return { percent, strokeClass: "stroke-severity-moderate" };
  if (p <= 1020) return { percent, strokeClass: "stroke-severity-low" };
  return { percent, strokeClass: "stroke-severity-moderate" };
}

/** Feels-like difference from actual */
function feelsLikeGauge(feelsLike: number, actual: number): GaugeConfig {
  const diff = Math.abs(feelsLike - actual);
  const percent = Math.min((diff / 15) * 100, 100);
  if (diff <= 2) return { percent: Math.max(percent, 8), strokeClass: "stroke-severity-low" };
  if (diff <= 5) return { percent, strokeClass: "stroke-severity-moderate" };
  if (diff <= 10) return { percent, strokeClass: "stroke-severity-high" };
  return { percent, strokeClass: "stroke-severity-severe" };
}

// ── Radial arc gauge component ───────────────────────────────────────────────
// 270° SVG arc gauge (open at bottom). Uses stroke-dasharray technique.
// The arc sweeps from 135° (bottom-left) to 405° (bottom-right).

const ARC_RADIUS = 20;
const ARC_CIRCUMFERENCE = 2 * Math.PI * ARC_RADIUS; // ~125.66
const ARC_SWEEP = 0.75; // 270° / 360°
const ARC_LENGTH = ARC_CIRCUMFERENCE * ARC_SWEEP; // ~94.25

function ArcGauge({ percent, strokeClass, value }: GaugeConfig & { value: string }) {
  const filledLength = (percent / 100) * ARC_LENGTH;

  return (
    <div
      className="relative flex shrink-0 items-center justify-center"
      role="meter"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${value}`}
    >
      <svg
        width="56"
        height="56"
        viewBox="0 0 48 48"
        className="overflow-visible"
        aria-hidden="true"
      >
        {/* Track arc (background) */}
        <circle
          cx="24"
          cy="24"
          r={ARC_RADIUS}
          fill="none"
          className="stroke-text-tertiary/15"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${ARC_LENGTH} ${ARC_CIRCUMFERENCE}`}
          transform="rotate(135 24 24)"
        />
        {/* Value arc (foreground) */}
        <circle
          cx="24"
          cy="24"
          r={ARC_RADIUS}
          fill="none"
          className={`${strokeClass} transition-all duration-500`}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${filledLength} ${ARC_CIRCUMFERENCE}`}
          transform="rotate(135 24 24)"
        />
      </svg>
      {/* Value text centered in the arc */}
      <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-text-primary">
        {value}
      </span>
    </div>
  );
}

// ── Metric card with radial gauge ────────────────────────────────────────────

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
    <div className="flex items-center gap-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm">
      {/* Radial gauge with value inside */}
      <ArcGauge {...gauge} value={value} />
      {/* Text info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-text-tertiary" aria-hidden="true">
            {icon}
          </span>
          <p className="text-sm font-medium text-text-secondary">{label}</p>
        </div>
        <p className={`mt-0.5 text-sm ${contextColor}`}>{context}</p>
      </div>
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
          icon={<DropletIcon size={16} />}
          label="Humidity"
          value={`${current.relative_humidity_2m}%`}
          context={humidityLabel(current.relative_humidity_2m)}
          gauge={humidityGauge(current.relative_humidity_2m)}
        />
        <MetricCard
          icon={<CloudIcon size={16} />}
          label="Cloud Cover"
          value={`${current.cloud_cover}%`}
          context={cloudLabel(current.cloud_cover)}
          gauge={cloudGauge(current.cloud_cover)}
        />
        <MetricCard
          icon={<WindIcon size={16} />}
          label="Wind"
          value={`${wind}`}
          context={`Gusts ${gusts} · ${windDirection(current.wind_direction_10m)}`}
          gauge={windGauge(wind)}
        />
        <MetricCard
          icon={<GaugeIcon size={16} />}
          label="Pressure"
          value={`${Math.round(current.surface_pressure)}`}
          context={pressureLabel(current.surface_pressure)}
          gauge={pressureGauge(current.surface_pressure)}
        />
        <MetricCard
          icon={<SunIcon size={16} />}
          label="UV Index"
          value={`${Math.round(current.uv_index)}`}
          context={uv.label}
          contextColor={uv.color}
          gauge={uvGauge(current.uv_index)}
        />
        <MetricCard
          icon={<EyeIcon size={16} />}
          label="Feels Like"
          value={`${Math.round(current.apparent_temperature)}°`}
          context={feelsLikeContext(current.apparent_temperature, current.temperature_2m)}
          gauge={feelsLikeGauge(current.apparent_temperature, current.temperature_2m)}
        />
      </div>
    </section>
  );
}
