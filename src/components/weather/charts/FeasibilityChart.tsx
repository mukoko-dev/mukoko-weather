"use client";

/**
 * FeasibilityChart — 24-hour activity feasibility line for an activity card.
 *
 * Plots the 0–100 feasibility score produced by `feasibilitySeries()`
 * (rules-engine evaluation of each forecast hour), colored with the
 * activity category's mineral color. Y-axis ticks show the rating words
 * (Poor/Fair/Good/Excellent) instead of raw numbers so the chart reads as
 * "when is this activity good today", not as an abstract score.
 */

import { TimeSeriesChart } from "./TimeSeriesChart";
import { scoreLabel, type FeasibilityPoint } from "@/lib/activity-feasibility";
import type { ActivityCategory } from "@/lib/activities";

/** Category → mineral color CSS custom property (see globals.css). */
const CATEGORY_CHART_COLORS: Partial<Record<ActivityCategory, string>> = {
  farming: "var(--mineral-malachite)",
  mining: "var(--mineral-terracotta)",
  travel: "var(--mineral-cobalt)",
  tourism: "var(--mineral-tanzanite)",
  sports: "var(--mineral-gold)",
  casual: "var(--color-primary)",
};

export function categoryChartColor(category: ActivityCategory): string {
  return CATEGORY_CHART_COLORS[category] ?? "var(--color-primary)";
}

export function prepareFeasibilityData(points: FeasibilityPoint[]) {
  return points.map((p) => ({
    label: `${String(new Date(p.time).getHours()).padStart(2, "0")}:00`,
    score: p.score,
  }));
}

export function FeasibilityChart({
  points,
  category,
}: {
  points: FeasibilityPoint[];
  category: ActivityCategory;
}) {
  const data = prepareFeasibilityData(points);
  if (data.length < 2) return null;

  const color = categoryChartColor(category);

  return (
    <TimeSeriesChart
      data={data}
      labelKey="label"
      series={[{ key: "score", label: "Feasibility", color, fill: true }]}
      yAxes={{
        y: {
          min: 0,
          max: 100,
          format: (v) => (v === 0 ? "" : v % 25 === 0 ? scoreLabel(v) : ""),
        },
      }}
      tooltipLabel={(_label, value) => scoreLabel(value)}
      maxTicksLimit={6}
      aspect="aspect-[16/5]"
    />
  );
}
