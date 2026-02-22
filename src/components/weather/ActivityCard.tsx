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

  return (
    <div className={`flex items-center gap-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm border-l-4 ${style.border}`}>
      {/* Activity icon */}
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${style.bg}`}>
        <span className={style.text} aria-hidden="true">
          <ActivityIcon activity={activity.id} icon={activity.icon} size={20} />
        </span>
      </div>
      {/* Activity info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-text-primary">{activity.label}</p>
          <span className={`rounded-[var(--radius-badge)] px-2 py-0.5 text-xs font-bold ${rating.bgClass} ${rating.colorClass}`}>
            {rating.label}
          </span>
          {rating.metric && (
            <span className="ml-auto text-xs font-medium text-text-tertiary tabular-nums">{rating.metric}</span>
          )}
        </div>
        <p className="mt-0.5 text-sm text-text-secondary">{rating.detail}</p>
      </div>
    </div>
  )
}
