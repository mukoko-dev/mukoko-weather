"use client";

import { useMemo, useState, useEffect } from "react";
import { useAppStore } from "@/lib/store";
import { type Activity, CATEGORY_STYLES } from "@/lib/activities";
import type { WeatherInsights } from "@/lib/weather";
import { fetchSuitabilityRules, fetchCategoryStyles, type CategoryStyle } from "@/lib/suitability-cache";
import { reportErrorToAnalytics } from "@/lib/observability";
import { SectionHeader } from "@/components/ui/section-header";
import { ActivityCard } from "./ActivityCard";
import type { SuitabilityRuleDoc } from "@/lib/db";

// Re-export for backward compatibility (tests import from this path)
export { evaluateSuitability } from "@/lib/suitability";

// ---------------------------------------------------------------------------
// Label helpers (exported for tests)
// ---------------------------------------------------------------------------

const MOON_PHASES = [
  "New Moon", "Waxing Crescent", "First Quarter", "Waxing Gibbous",
  "Full Moon", "Waning Gibbous", "Third Quarter", "Waning Crescent",
] as const;

export function moonPhaseName(phase: number): string {
  return MOON_PHASES[phase] ?? "Unknown";
}

export function heatStressLevel(index: number): { label: string; className: string } {
  if (index < 22) return { label: "None", className: "text-severity-low" };
  if (index < 24) return { label: "Mild", className: "text-severity-moderate" };
  if (index < 26) return { label: "Moderate", className: "text-severity-high" };
  if (index < 28) return { label: "Medium", className: "text-severity-high" };
  if (index < 30) return { label: "Severe", className: "text-severity-severe" };
  return { label: "Extreme", className: "text-severity-extreme" };
}

export function precipTypeName(type: number): string {
  switch (type) {
    case 0: return "None";
    case 1: return "Rain";
    case 2: return "Snow";
    case 3: return "Freezing Rain";
    case 4: return "Ice Pellets";
    default: return "Unknown";
  }
}

export function uvConcernLabel(concern: number): { label: string; className: string } {
  if (concern <= 2) return { label: "Low", className: "text-severity-low" };
  if (concern <= 5) return { label: "Moderate", className: "text-severity-moderate" };
  if (concern <= 7) return { label: "High", className: "text-severity-high" };
  if (concern <= 10) return { label: "Very High", className: "text-severity-severe" };
  return { label: "Extreme", className: "text-severity-extreme" };
}

// ---------------------------------------------------------------------------
// Default category style (when API data hasn't loaded yet)
// ---------------------------------------------------------------------------

const DEFAULT_STYLE: CategoryStyle = {
  bg: "bg-primary/10",
  border: "border-primary",
  text: "text-primary",
  badge: "bg-primary text-primary-foreground",
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ActivityInsights({
  insights,
  activities,
}: {
  insights?: WeatherInsights;
  /** All activities from MongoDB — passed from parent. Empty array = loading, show nothing. */
  activities: Activity[];
}) {
  const selectedActivities = useAppStore((s) => s.selectedActivities);
  const openMyWeather = useAppStore((s) => s.openMyWeather);

  // Fetch suitability rules from database (module-level cache, 10min TTL)
  const [dbRules, setDbRules] = useState<Map<string, SuitabilityRuleDoc>>(new Map());
  // Seed with static CATEGORY_STYLES for instant mineral color rendering;
  // upgraded with DB-only categories after fetch resolves.
  const [categoryStyles, setCategoryStyles] = useState<Record<string, CategoryStyle>>(CATEGORY_STYLES);

  useEffect(() => {
    Promise.all([
      fetchSuitabilityRules()
        .then((rules) => {
          if (rules.length) {
            const rulesMap = new Map<string, SuitabilityRuleDoc>();
            for (const rule of rules) rulesMap.set(rule.key, rule);
            setDbRules(rulesMap);
          }
        })
        .catch((err) => {
          reportErrorToAnalytics(`Suitability rules fetch failed: ${err instanceof Error ? err.message : "unknown"}`, false);
        }),
      fetchCategoryStyles()
        .then((styles) => {
          if (Object.keys(styles).length) setCategoryStyles(styles);
        })
        .catch((err) => {
          reportErrorToAnalytics(`Category styles fetch failed: ${err instanceof Error ? err.message : "unknown"}`, false);
        }),
    ]);
  }, []);

  const selectedItems = useMemo(() => {
    return selectedActivities
      .map((id) => activities.find((a) => a.id === id))
      .filter((a): a is Activity => a != null);
  }, [selectedActivities, activities]);

  if (selectedItems.length === 0) return null;

  // When insights data is available, show per-activity suitability cards
  if (insights) {
    return (
      <section aria-labelledby="activity-insights-heading">
        <SectionHeader
          headingId="activity-insights-heading"
          title="My Activities"
          action={{ label: "Edit", onClick: openMyWeather }}
          className="mb-3"
        />
        <div className="space-y-2">
          {selectedItems.map((activity) => (
            <ActivityCard key={activity.id} activity={activity} insights={insights} dbRules={dbRules} categoryStyles={categoryStyles} />
          ))}
        </div>
      </section>
    );
  }

  // Fallback: show selected activities as badges when insights data isn't available
  return (
    <section aria-label="Selected activities">
      <div className="rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm sm:p-6">
        <SectionHeader
          headingId="activity-fallback-heading"
          title="Your Activities"
          as="h3"
          action={{ label: "Edit", onClick: openMyWeather }}
          className="mb-3"
        />
        <div className="flex flex-wrap gap-2">
          {selectedItems.map((activity) => {
            const style = categoryStyles[activity.category] ?? DEFAULT_STYLE;
            return (
              <span
                key={activity.id}
                className={`inline-flex items-center gap-1.5 rounded-[var(--radius-badge)] px-3 py-1.5 text-sm font-medium ${style.badge}`}
              >
                {activity.label}
              </span>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-text-tertiary">
          Detailed activity insights appear when extended weather data is available.
        </p>
      </div>
    </section>
  );
}
