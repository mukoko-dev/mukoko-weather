"use client";

import { useAppStore } from "@/lib/store";

/**
 * A quiet, in-context invitation to pick activities. This replaced the old
 * first-visit welcome banner: activities are optional, so they are offered
 * where their payoff is, not above the temperature. The location page shows
 * it only while nothing is selected; once activities are picked the advice
 * lives in the Community lane's sheet (ActivitiesDetailSheet).
 */
export function ActivityInvite() {
  const openMyWeather = useAppStore((s) => s.openMyWeather);
  return (
    <section
      aria-labelledby="activity-insights-empty-heading"
      className="acacia"
    >
      <h2 id="activity-insights-empty-heading" className="giraffe">
        Advice for what you do
      </h2>
      <p className="mt-1 gazelle">
        Farming, football, a braai, the school run — pick a few activities and
        we&apos;ll tell you how today&apos;s weather affects them.
      </p>
      <button
        type="button"
        onClick={() => openMyWeather("activities")}
        className="impala-sm mt-3"
      >
        Choose activities
      </button>
    </section>
  );
}
