"use client";

import { useRef, useState, useEffect, lazy, Suspense } from "react";
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
 * Uses IntersectionObserver to defer mounting the 4 heavy Recharts charts
 * until the user scrolls near them. This dramatically reduces initial memory
 * usage on mobile devices where all 6 charts would otherwise mount at once.
 */
export function LazyAtmosphericDetails({ hourly }: { hourly: HourlyWeather }) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  // If IntersectionObserver is unavailable, render immediately
  const [visible, setVisible] = useState(
    () => typeof window !== "undefined" && typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    if (visible) return;
    const el = sentinelRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      // Start loading when the section is within 200px of the viewport
      { rootMargin: "200px" },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  if (!visible) {
    return (
      <div ref={sentinelRef} aria-hidden="true" className="h-24" />
    );
  }

  return (
    <Suspense fallback={<AtmosphericDetailsSkeleton />}>
      <AtmosphericDetails hourly={hourly} />
    </Suspense>
  );
}
