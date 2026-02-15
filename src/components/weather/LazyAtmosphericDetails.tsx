"use client";

import { lazy, Suspense } from "react";
import type { HourlyWeather } from "@/lib/weather";

const AtmosphericDetails = lazy(() =>
  import("./AtmosphericDetails").then((mod) => ({
    default: mod.AtmosphericDetails,
  })),
);

function AtmosphericDetailsSkeleton() {
  return (
    <section aria-label="Loading atmospheric details">
      <div className="rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm sm:p-6">
        <div className="h-5 w-48 animate-pulse rounded bg-text-tertiary/20" />
        <div className="mt-2 h-4 w-36 animate-pulse rounded bg-text-tertiary/10" />
        <div className="mt-4 space-y-6">
          <div className="h-24 animate-pulse rounded bg-text-tertiary/10" />
          <div className="h-24 animate-pulse rounded bg-text-tertiary/10" />
        </div>
      </div>
    </section>
  );
}

/**
 * Lazy-loading wrapper for AtmosphericDetails.
 *
 * Uses React.lazy() for code-splitting the Canvas chart components.
 * The actual viewport-based lazy loading is handled by LazySection
 * in the parent dashboard, so this wrapper only handles code-splitting.
 */
export function LazyAtmosphericDetails({ hourly }: { hourly: HourlyWeather }) {
  return (
    <Suspense fallback={<AtmosphericDetailsSkeleton />}>
      <AtmosphericDetails hourly={hourly} />
    </Suspense>
  );
}
