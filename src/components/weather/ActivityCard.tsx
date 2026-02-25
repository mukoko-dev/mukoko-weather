"use client"

import type { Activity } from "@/lib/activities"
import type { WeatherInsights } from "@/lib/weather"
import type { CategoryStyle } from "@/lib/suitability-cache"
import type { SuitabilityRuleDoc } from "@/lib/db"
import { ActivityIcon } from "@/lib/weather-icons"
import { evaluateSuitability } from "@/lib/suitability"

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
// ActivityCard — suitability card for a single activity
// ---------------------------------------------------------------------------

export interface ActivityCardProps {
  activity: Activity
  insights: WeatherInsights
  dbRules: Map<string, SuitabilityRuleDoc>
  categoryStyles: Record<string, CategoryStyle>
}

export function ActivityCard({
  activity,
  insights,
  dbRules,
  categoryStyles,
}: ActivityCardProps) {
  const style = categoryStyles[activity.category] ?? DEFAULT_STYLE
  const rating = evaluateSuitability(activity, insights, dbRules)
  // Use borderAccent (border-l-{color}) for the left accent stripe.
  // Fall back to deriving it from border when loading from older MongoDB data.
  const borderAccent = style.borderAccent ?? style.border.replace(/^border-/, "border-l-")

  return (
    <div className={`flex items-center gap-4 rounded-[var(--radius-card)] bg-surface-card p-5 shadow-sm border border-primary/25 border-l-[6px] ${borderAccent}`}>
      {/* Activity icon */}
      <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${style.bg}`}>
        <span className={style.text} aria-hidden="true">
          <ActivityIcon activity={activity.id} icon={activity.icon} size={22} />
        </span>
      </div>
      {/* Activity info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-base font-semibold text-text-primary">{activity.label}</p>
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
  )
}
