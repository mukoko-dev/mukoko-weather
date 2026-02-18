"use client";

import { useMemo, useState, useEffect } from "react";
import { useAppStore } from "@/lib/store";
import { CATEGORY_STYLES, type Activity } from "@/lib/activities";
import type { WeatherInsights } from "@/lib/weather";
import { ActivityIcon } from "@/lib/weather-icons";

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
// Suitability rating engine
// ---------------------------------------------------------------------------

interface SuitabilityRating {
  level: "excellent" | "good" | "fair" | "poor";
  label: string;
  colorClass: string;
  bgClass: string;
  /** Key insight line for this activity */
  detail: string;
  /** Secondary metric value */
  metric?: string;
}

function farmingSuitability(insights: WeatherInsights): SuitabilityRating {
  const base = { metric: insights.gdd10To30 != null ? `GDD: ${insights.gdd10To30.toFixed(1)}` : undefined };
  if (insights.dewPoint != null && insights.dewPoint > 20) {
    return { ...base, level: "fair", label: "Fair", colorClass: "text-severity-high", bgClass: "bg-severity-high/10", detail: "High dew point — disease risk for crops" };
  }
  if (insights.dewPoint != null && insights.dewPoint < 5) {
    return { ...base, level: "poor", label: "Poor", colorClass: "text-severity-cold", bgClass: "bg-severity-cold/10", detail: "Low dew point — frost risk" };
  }
  if (insights.precipitationType != null && insights.precipitationType >= 2) {
    return { ...base, level: "poor", label: "Poor", colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10", detail: `${precipTypeName(insights.precipitationType)} expected — protect crops` };
  }
  if (insights.evapotranspiration != null && insights.evapotranspiration > 5) {
    return { ...base, level: "fair", label: "Fair", colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10", detail: `High water loss (${insights.evapotranspiration.toFixed(1)} mm) — irrigate early` };
  }
  return { ...base, level: "good", label: "Good", colorClass: "text-severity-low", bgClass: "bg-severity-low/10", detail: "Favorable conditions for fieldwork" };
}

function miningSuitability(insights: WeatherInsights): SuitabilityRating {
  if (insights.thunderstormProbability != null && insights.thunderstormProbability > 50) {
    return { level: "poor", label: "Poor", colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10", detail: "Suspend outdoor operations — lightning risk", metric: `Storm: ${Math.round(insights.thunderstormProbability)}%` };
  }
  if (insights.heatStressIndex != null && insights.heatStressIndex >= 28) {
    return { level: "poor", label: "Poor", colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10", detail: `${heatStressLevel(insights.heatStressIndex).label} heat stress — mandatory rest breaks`, metric: `Heat: ${insights.heatStressIndex.toFixed(0)}` };
  }
  if (insights.heatStressIndex != null && insights.heatStressIndex >= 24) {
    return { level: "fair", label: "Fair", colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10", detail: "Moderate heat stress — hydration breaks needed", metric: `Heat: ${insights.heatStressIndex.toFixed(0)}` };
  }
  if (insights.thunderstormProbability != null && insights.thunderstormProbability > 20) {
    return { level: "fair", label: "Fair", colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10", detail: "Monitor storm conditions closely", metric: `Storm: ${Math.round(insights.thunderstormProbability)}%` };
  }
  return { level: "good", label: "Good", colorClass: "text-severity-low", bgClass: "bg-severity-low/10", detail: "Safe conditions for outdoor work", metric: insights.visibility != null ? `Vis: ${insights.visibility.toFixed(1)} km` : undefined };
}

function sportsSuitability(insights: WeatherInsights): SuitabilityRating {
  if (insights.thunderstormProbability != null && insights.thunderstormProbability > 40) {
    return { level: "poor", label: "Poor", colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10", detail: "Move indoors — thunderstorm risk", metric: `Storm: ${Math.round(insights.thunderstormProbability)}%` };
  }
  if (insights.heatStressIndex != null && insights.heatStressIndex >= 28) {
    return { level: "poor", label: "Poor", colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10", detail: "Too hot for outdoor exercise", metric: `Heat: ${insights.heatStressIndex.toFixed(0)}` };
  }
  if (insights.uvHealthConcern != null && insights.uvHealthConcern > 7) {
    return { level: "fair", label: "Fair", colorClass: "text-severity-high", bgClass: "bg-severity-high/10", detail: "Very high UV — sun protection essential", metric: `UV: ${insights.uvHealthConcern}` };
  }
  if (insights.heatStressIndex != null && insights.heatStressIndex >= 24) {
    return { level: "fair", label: "Fair", colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10", detail: "Warm — stay hydrated during exercise", metric: `Heat: ${insights.heatStressIndex.toFixed(0)}` };
  }
  return { level: "excellent", label: "Excellent", colorClass: "text-severity-low", bgClass: "bg-severity-low/10", detail: "Great conditions for outdoor activity", metric: insights.uvHealthConcern != null ? `UV: ${insights.uvHealthConcern}` : undefined };
}

function travelSuitability(insights: WeatherInsights): SuitabilityRating {
  if (insights.visibility != null && insights.visibility < 1) {
    return { level: "poor", label: "Poor", colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10", detail: "Very poor visibility — delay travel if possible", metric: `Vis: ${insights.visibility.toFixed(1)} km` };
  }
  if (insights.thunderstormProbability != null && insights.thunderstormProbability > 50) {
    return { level: "poor", label: "Poor", colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10", detail: "Storm risk — avoid unnecessary travel", metric: `Storm: ${Math.round(insights.thunderstormProbability)}%` };
  }
  if (insights.visibility != null && insights.visibility < 5) {
    return { level: "fair", label: "Fair", colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10", detail: "Reduced visibility — drive with caution", metric: `Vis: ${insights.visibility.toFixed(1)} km` };
  }
  if (insights.precipitationType != null && insights.precipitationType > 0) {
    return { level: "fair", label: "Fair", colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10", detail: `${precipTypeName(insights.precipitationType)} — wet road conditions`, metric: insights.visibility != null ? `Vis: ${insights.visibility.toFixed(1)} km` : undefined };
  }
  return { level: "good", label: "Good", colorClass: "text-severity-low", bgClass: "bg-severity-low/10", detail: "Clear conditions for travel", metric: insights.visibility != null ? `Vis: ${insights.visibility.toFixed(1)} km` : undefined };
}

function tourismSuitability(insights: WeatherInsights): SuitabilityRating {
  if (insights.uvHealthConcern != null && insights.uvHealthConcern > 7) {
    return { level: "fair", label: "Fair", colorClass: "text-severity-high", bgClass: "bg-severity-high/10", detail: "Very high UV — seek shade during midday", metric: `UV: ${insights.uvHealthConcern}` };
  }
  if (insights.visibility != null && insights.visibility < 5) {
    return { level: "fair", label: "Fair", colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10", detail: "Limited visibility may affect game viewing", metric: `Vis: ${insights.visibility.toFixed(1)} km` };
  }
  const moonInfo = insights.moonPhase != null ? moonPhaseName(insights.moonPhase) : undefined;
  return { level: "good", label: "Good", colorClass: "text-severity-low", bgClass: "bg-severity-low/10", detail: moonInfo ? `${moonInfo} tonight — great for night viewing` : "Good conditions for outdoor activities", metric: insights.visibility != null ? `Vis: ${insights.visibility.toFixed(1)} km` : undefined };
}

function casualSuitability(insights: WeatherInsights): SuitabilityRating {
  if (insights.thunderstormProbability != null && insights.thunderstormProbability > 40) {
    return { level: "poor", label: "Poor", colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10", detail: "Thunderstorm risk — stay indoors", metric: `Storm: ${Math.round(insights.thunderstormProbability)}%` };
  }
  if (insights.heatStressIndex != null && insights.heatStressIndex >= 28) {
    return { level: "fair", label: "Fair", colorClass: "text-severity-high", bgClass: "bg-severity-high/10", detail: "Very warm — limit time outdoors", metric: `Heat: ${insights.heatStressIndex.toFixed(0)}` };
  }
  if (insights.uvHealthConcern != null && insights.uvHealthConcern > 7) {
    return { level: "fair", label: "Fair", colorClass: "text-severity-high", bgClass: "bg-severity-high/10", detail: "High UV — wear sunscreen and a hat", metric: `UV: ${insights.uvHealthConcern}` };
  }
  return { level: "excellent", label: "Excellent", colorClass: "text-severity-low", bgClass: "bg-severity-low/10", detail: "Perfect for outdoor plans", metric: insights.uvHealthConcern != null ? `UV: ${insights.uvHealthConcern}` : undefined };
}

const SUITABILITY_FN: Record<string, (insights: WeatherInsights) => SuitabilityRating> = {
  farming: farmingSuitability,
  mining: miningSuitability,
  sports: sportsSuitability,
  travel: travelSuitability,
  tourism: tourismSuitability,
  casual: casualSuitability,
  city: casualSuitability,
  education: sportsSuitability,
  border: travelSuitability,
  "national-park": tourismSuitability,
};

// ---------------------------------------------------------------------------
// Activity suitability card (Tomorrow.io style)
// ---------------------------------------------------------------------------

function ActivityCard({ activity, insights }: { activity: Activity; insights: WeatherInsights }) {
  const style = CATEGORY_STYLES[activity.category] ?? CATEGORY_STYLES.casual;
  const getSuitability = SUITABILITY_FN[activity.category] ?? casualSuitability;
  const rating = getSuitability(insights);

  return (
    <div className={`flex items-center gap-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm border-l-4 ${style.border}`}>
      {/* Activity icon */}
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${style.bg}`}>
        <span className={style.text} aria-hidden="true">
          <ActivityIcon activity={activity.id} size={20} />
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
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ActivityInsights({ insights }: { insights?: WeatherInsights }) {
  const selectedActivities = useAppStore((s) => s.selectedActivities);
  const openMyWeather = useAppStore((s) => s.openMyWeather);
  const [allActivities, setAllActivities] = useState<Activity[]>([]);

  useEffect(() => {
    fetch("/api/activities")
      .then((res) => (res.ok ? res.json() : { activities: [] }))
      .then((data) => setAllActivities(data.activities ?? []))
      .catch(() => {});
  }, []);

  const selectedItems = useMemo(() => {
    return selectedActivities
      .map((id) => allActivities.find((a) => a.id === id))
      .filter((a): a is Activity => a != null);
  }, [selectedActivities, allActivities]);

  if (selectedItems.length === 0) return null;

  // When insights data is available, show per-activity suitability cards
  if (insights) {
    return (
      <section aria-labelledby="activity-insights-heading">
        <div className="mb-3 flex items-center justify-between">
          <h2
            id="activity-insights-heading"
            className="text-lg font-semibold text-text-primary font-heading"
          >
            My Activities
          </h2>
          <button
            onClick={openMyWeather}
            className="text-sm font-medium text-primary transition-colors hover:text-primary/80"
          >
            Edit
          </button>
        </div>
        <div className="space-y-2">
          {selectedItems.map((activity) => (
            <ActivityCard key={activity.id} activity={activity} insights={insights} />
          ))}
        </div>
      </section>
    );
  }

  // Fallback: show selected activities as badges when insights data isn't available
  return (
    <section aria-label="Selected activities">
      <div className="rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm sm:p-6">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-text-primary font-heading">Your Activities</h3>
          <button
            onClick={openMyWeather}
            className="text-sm font-medium text-primary hover:text-primary/80 transition-colors"
          >
            Edit
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {selectedItems.map((activity) => {
            const style = CATEGORY_STYLES[activity.category] ?? CATEGORY_STYLES.casual;
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
