"use client"

import { useMemo } from "react"
import type { Activity } from "@/lib/activities"
import type { WeatherData, WeatherInsights } from "@/lib/weather"
import type { CategoryStyle } from "@/lib/suitability-cache"
import type { SuitabilityRuleDoc } from "@/lib/db"
import { ActivityIcon } from "@/lib/weather-icons"
import { evaluateSuitability } from "@/lib/suitability"
import { feasibilitySeries } from "@/lib/activity-feasibility"
import { getActivityTips } from "@/lib/activity-tips"
import { FeasibilityChart } from "./charts/FeasibilityChart"

// ---------------------------------------------------------------------------
// Default category style (when API data hasn't loaded yet)
// ---------------------------------------------------------------------------

const DEFAULT_STYLE: CategoryStyle = {
  bg: "bg-primary/10",
  border: "border-primary",
  borderAccent: "border-l-primary",
  text: "text-primary",
  badge: "bg-primary text-primary-foreground",
}

// ---------------------------------------------------------------------------
// ActivityCard — suitability card for a single activity: current rating
// badge + detail, a 24h feasibility trend line, and weather-driven tips
// ---------------------------------------------------------------------------

export interface ActivityCardProps {
  activity: Activity
  insights: WeatherInsights
  dbRules: Map<string, SuitabilityRuleDoc>
  categoryStyles: Record<string, CategoryStyle>
  /** Full weather payload — powers the feasibility trend + tips. Optional so
   *  the card still renders (badge + detail only) without forecast data. */
  weather?: WeatherData
}

export function ActivityCard({
  activity,
  insights,
  dbRules,
  categoryStyles,
  weather,
}: ActivityCardProps) {
  const style = categoryStyles[activity.category] ?? DEFAULT_STYLE
  const rating = evaluateSuitability(activity, insights, dbRules)
  // Use borderAccent (border-l-{color}) for the left accent stripe.
  // Fall back to deriving it from border when loading from older MongoDB data.
  const borderAccent = style.borderAccent ?? style.border.replace(/^border-/, "border-l-")

  // 24h feasibility trend — evaluates the same DB rule against each forecast
  // hour. Empty when rules haven't loaded or hourly data is missing.
  const trend = useMemo(
    () => (weather ? feasibilitySeries(activity, weather.hourly, dbRules) : []),
    [activity, weather, dbRules],
  )

  // Weather-driven tips (deterministic, category-aware)
  const tips = useMemo(
    () => (weather ? getActivityTips(activity, weather) : []),
    [activity, weather],
  )

  const headingId = `activity-card-${activity.id}`

  return (
    <div
      className={`baobab p-3.5 border-l-[6px] ${borderAccent}`}
      role="group"
      aria-labelledby={headingId}
    >
      <div className="flex items-center gap-3">
        {/* Activity icon */}
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${style.bg}`}>
          <span className={style.text} aria-hidden="true">
            <ActivityIcon activity={activity.id} icon={activity.icon} size={18} />
          </span>
        </div>
        {/* Activity info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p id={headingId} className="text-base font-semibold text-text-primary">{activity.label}</p>
            <span className={`rounded-[var(--radius-badge)] px-2.5 py-0.5 text-base font-bold ${rating.bgClass} ${rating.colorClass}`}>
              {rating.label}
            </span>
            {rating.metric && (
              <span className="ml-auto text-base font-medium text-text-tertiary tabular-nums">{rating.metric}</span>
            )}
          </div>
          <p className="mt-1 text-base text-text-secondary">{rating.detail}</p>
        </div>
      </div>

      {/* 24h feasibility trend */}
      {trend.length >= 2 && (
        <div className="mt-3">
          <p className="dove mb-1">Next 24 hours</p>
          <FeasibilityChart points={trend} category={activity.category} />
        </div>
      )}

      {/* Weather-driven tips */}
      {tips.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {tips.map((tip) => (
            <li key={tip} className="flex gap-2 text-base text-text-secondary leading-relaxed">
              <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${style.bg}`} aria-hidden="true" />
              {tip}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
