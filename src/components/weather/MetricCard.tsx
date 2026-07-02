"use client"

import * as React from "react"
import { resolveColor } from "@/components/ui/chart"

// ---------------------------------------------------------------------------
// ArcGauge — radial arc gauge (270° sweep, open at bottom)
// Uses stroke-dasharray on an SVG circle for the filled arc. The filled arc
// is painted with a multi-colour SVG <linearGradient> whose stops are the
// metric's mineral/severity ramp, resolved from globals.css CSS custom
// properties to concrete colours at render time (mirrors how the Chart.js
// charts resolve `var(--…)` via resolveColor).
// ---------------------------------------------------------------------------

// Geometry — a bigger gauge so the arc is the visual anchor of each card and
// the value text has generous room in the open centre.
export const ARC_VIEWBOX = 80
const ARC_CENTER = ARC_VIEWBOX / 2 // 40
export const ARC_RADIUS = 32
export const ARC_STROKE_WIDTH = 7
const ARC_CIRCUMFERENCE = 2 * Math.PI * ARC_RADIUS // ~201.06
const ARC_SWEEP = 0.75 // 270° / 360°
const ARC_LENGTH = ARC_CIRCUMFERENCE * ARC_SWEEP // ~150.80
const ARC_ROTATION = 135 // arc opening centred at the bottom

export interface GaugeConfig {
  /** Value as percentage of the gauge (0-100) */
  percent: number
  /** CSS class for the stroke color of the filled arc (severity semantics + fallback) */
  strokeClass: string
  /**
   * Optional ordered list of CSS custom-property references (e.g.
   * `"var(--color-severity-low)"`) forming the multi-colour arc gradient.
   * When omitted, a gradient is derived from `strokeClass` so every gauge
   * still sweeps colour.
   */
  gradient?: string[]
}

// Map a severity stroke class to its CSS custom-property token. Used to derive
// a gradient when a gauge doesn't supply an explicit `gradient` ramp.
const STROKE_TO_TOKEN: Record<string, string> = {
  "stroke-severity-low": "var(--color-severity-low)",
  "stroke-severity-moderate": "var(--color-severity-moderate)",
  "stroke-severity-high": "var(--color-severity-high)",
  "stroke-severity-severe": "var(--color-severity-severe)",
  "stroke-severity-extreme": "var(--color-severity-extreme)",
  "stroke-severity-cold": "var(--color-severity-cold)",
}

// Ordered severity ramp — the natural malachite→gold→terracotta→red sweep.
const SEVERITY_RAMP = [
  "var(--color-severity-low)",
  "var(--color-severity-moderate)",
  "var(--color-severity-high)",
  "var(--color-severity-severe)",
  "var(--color-severity-extreme)",
]

/**
 * Derive a multi-colour gradient ramp from a single severity stroke class.
 * Produces the ramp from the lowest severity up to (and including) the
 * class's own severity, so a "severe" gauge sweeps low→moderate→high→severe.
 */
export function gradientFromStrokeClass(strokeClass: string): string[] {
  const token = STROKE_TO_TOKEN[strokeClass]
  if (!token) return SEVERITY_RAMP.slice(0, 2)
  // severity-cold isn't part of the linear ramp — pair it with low for a sweep.
  if (token === "var(--color-severity-cold)") {
    return ["var(--color-severity-low)", token]
  }
  const idx = SEVERITY_RAMP.indexOf(token)
  if (idx <= 0) return SEVERITY_RAMP.slice(0, 2)
  return SEVERITY_RAMP.slice(0, idx + 1)
}

/**
 * Resolve a list of CSS custom-property tokens to concrete colours, keeping
 * them in sync with the active theme. Resolves on mount and again whenever
 * the document's `data-theme` attribute changes (SVG paint servers need
 * concrete colour values, not `var(--…)` references).
 */
function useResolvedColors(tokens: string[]): string[] {
  const key = tokens.join(",")
  const [colors, setColors] = React.useState<string[]>(() => tokens.map(resolveColor))

  React.useEffect(() => {
    const resolve = () => setColors(key.split(",").map(resolveColor))
    resolve()
    if (typeof MutationObserver === "undefined") return
    const observer = new MutationObserver(resolve)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    })
    return () => observer.disconnect()
  }, [key])

  return colors
}

/**
 * Pick a value text size that fits cleanly inside the gauge's open centre.
 * Longer strings (e.g. "1013", "12mm") step down so the number never collides
 * with the arc stroke.
 */
export function valueTextSizeClass(value: string): string {
  const len = value.length
  if (len <= 3) return "text-2xl"
  if (len <= 4) return "text-xl"
  if (len <= 6) return "text-lg"
  return "text-sm"
}

export function ArcGauge({ percent, strokeClass, gradient, value }: GaugeConfig & { value: string }) {
  const clampedPercent = Math.max(0, Math.min(percent, 100))
  const filledLength = (clampedPercent / 100) * ARC_LENGTH

  // A stable, unique gradient id so multiple gauges on the page don't collide.
  const rawId = React.useId()
  const gradientId = `arc-gauge-${rawId.replace(/:/g, "")}`

  const tokens = React.useMemo(
    () => gradient ?? gradientFromStrokeClass(strokeClass),
    [gradient, strokeClass],
  )
  const resolved = useResolvedColors(tokens)
  const stops = resolved.length > 0 ? resolved : tokens

  return (
    <div
      className="relative flex h-24 w-24 shrink-0 items-center justify-center"
      role="meter"
      aria-valuenow={Math.round(clampedPercent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${value}`}
    >
      <svg
        viewBox={`0 0 ${ARC_VIEWBOX} ${ARC_VIEWBOX}`}
        className="h-24 w-24 overflow-visible"
        aria-hidden="true"
      >
        <defs>
          {/* Horizontal ramp across the arc's width — the fill reveals more of
              the ramp as the value grows, so severity reads left→right. */}
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1={ARC_CENTER - ARC_RADIUS}
            y1={ARC_CENTER}
            x2={ARC_CENTER + ARC_RADIUS}
            y2={ARC_CENTER}
          >
            {stops.map((color, i) => (
              <stop
                key={i}
                offset={stops.length === 1 ? 1 : i / (stops.length - 1)}
                stopColor={color}
              />
            ))}
          </linearGradient>
        </defs>
        {/* Track arc (background) */}
        <circle
          cx={ARC_CENTER}
          cy={ARC_CENTER}
          r={ARC_RADIUS}
          fill="none"
          className="stroke-text-tertiary/15"
          strokeWidth={ARC_STROKE_WIDTH}
          strokeLinecap="round"
          strokeDasharray={`${ARC_LENGTH} ${ARC_CIRCUMFERENCE}`}
          transform={`rotate(${ARC_ROTATION} ${ARC_CENTER} ${ARC_CENTER})`}
        />
        {/* Value arc (foreground) — gradient stroke */}
        <circle
          cx={ARC_CENTER}
          cy={ARC_CENTER}
          r={ARC_RADIUS}
          fill="none"
          stroke={`url(#${gradientId})`}
          className="transition-all duration-500"
          strokeWidth={ARC_STROKE_WIDTH}
          strokeLinecap="round"
          strokeDasharray={`${filledLength} ${ARC_CIRCUMFERENCE}`}
          transform={`rotate(${ARC_ROTATION} ${ARC_CENTER} ${ARC_CENTER})`}
        />
      </svg>
      {/* Value text — centred above the arc, sized to fit the open area */}
      <span
        className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-3 text-center font-bold leading-none tabular-nums text-text-primary ${valueTextSizeClass(value)}`}
      >
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
    <div className="flex flex-col items-center gap-1.5 baobab p-3 transition-shadow hover:shadow-md text-center">
      {/* Radial gauge with value inside */}
      <ArcGauge {...gauge} value={value} />
      {/* Text info */}
      <div className="min-w-0">
        <div className="flex items-center justify-center gap-1.5">
          <span className="text-text-tertiary" aria-hidden="true">
            {icon}
          </span>
          <p className="text-base font-medium text-text-secondary">{label}</p>
        </div>
        <p className={`mt-1 text-base ${contextColor}`}>{context}</p>
      </div>
    </div>
  )
}
