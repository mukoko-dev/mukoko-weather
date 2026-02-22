import * as React from "react"

// ---------------------------------------------------------------------------
// ArcGauge — radial arc gauge (270° sweep, open at bottom)
// Uses stroke-dasharray on SVG circle for the filled arc.
// ---------------------------------------------------------------------------

export interface GaugeConfig {
  /** Value as percentage of the gauge (0-100) */
  percent: number
  /** CSS class for the stroke color of the filled arc */
  strokeClass: string
}

const ARC_RADIUS = 20
const ARC_CIRCUMFERENCE = 2 * Math.PI * ARC_RADIUS // ~125.66
const ARC_SWEEP = 0.75 // 270° / 360°
const ARC_LENGTH = ARC_CIRCUMFERENCE * ARC_SWEEP // ~94.25

export function ArcGauge({ percent, strokeClass, value }: GaugeConfig & { value: string }) {
  const filledLength = (percent / 100) * ARC_LENGTH

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
  )
}

// ---------------------------------------------------------------------------
// MetricCard — compact metric display with radial gauge
// ---------------------------------------------------------------------------

export interface MetricCardProps {
  icon: React.ReactNode
  label: string
  value: string
  context: string
  contextColor?: string
  gauge: GaugeConfig
}

export function MetricCard({
  icon,
  label,
  value,
  context,
  contextColor = "text-text-tertiary",
  gauge,
}: MetricCardProps) {
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
  )
}
