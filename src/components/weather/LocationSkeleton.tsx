"use client";

import { useEffect, useState } from "react";
import { Shimmer } from "@/components/ui/shimmer";
import { HeroSkeleton } from "@/components/weather/HeroSkeleton";
import { WeatherSky } from "@/components/weather/WeatherSky";
import {
  InsightGrid,
  insightCardSizeClass,
} from "@/components/weather/widgets/InsightCard";
import { useAppStore } from "@/lib/store";
import { getCachedWeatherHint } from "@/lib/weather-scenes/cache";
import { skeletonLook, type SkeletonLook } from "@/lib/location-skeleton";
import {
  MAIN_COLUMN_CLASS,
  SIDEBAR_COLUMN_CLASS,
} from "@/lib/dashboard-layout";
import { cn } from "@/lib/utils";

/** Hourly cells in the strip skeleton (the real strip scrolls past these). */
export const HOURLY_PLACEHOLDER_COUNT = 8;
/** Square tiles in the Conditions grid skeleton (2 rows of 2, one row of 4). */
export const TILE_PLACEHOLDER_COUNT = 4;

/** The "Hourly" section: header row plus a strip of hour cells. */
export function HourlyStripSkeleton() {
  return (
    <section aria-hidden="true">
      <div className="mb-[var(--space-stack)] flex min-h-[var(--touch-target-min)] items-center justify-between gap-2">
        <h2 className="giraffe">
          <Shimmer className="h-[0.7em] w-16" />
        </h2>
        <Shimmer className="h-4 w-28" />
      </div>
      <div className="baobab overflow-hidden p-3">
        <div className="flex gap-2.5 pb-2">
          {Array.from({ length: HOURLY_PLACEHOLDER_COUNT }, (_, i) => (
            <div
              key={i}
              className="flex min-w-[60px] flex-col items-center gap-1.5 rounded-[var(--radius-input)] bg-surface-base px-2.5 py-2"
            >
              <span className="text-base font-medium">
                <Shimmer className="h-[0.7em] w-9" />
              </span>
              <Shimmer className="size-5 rounded-full" />
              <span className="text-base font-semibold">
                <Shimmer className="h-[0.7em] w-7" />
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** The Conditions grid: the same container-query grid and tile box as the
 *  real `InsightCard` squares (2 columns, 4 when the column is wide). */
export function TileGridSkeleton() {
  return (
    <section aria-hidden="true">
      <InsightGrid>
        {Array.from({ length: TILE_PLACEHOLDER_COUNT }, (_, i) => (
          <div
            key={i}
            data-skeleton="tile"
            className={cn(
              "acacia flex min-w-0 flex-col gap-3",
              insightCardSizeClass("square"),
            )}
          >
            <Shimmer className="h-4 w-16" />
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <Shimmer className="size-20 rounded-full" />
            </div>
            <Shimmer className="h-3 w-3/4" />
          </div>
        ))}
      </InsightGrid>
    </section>
  );
}

/** Two quiet cards for the desktop sidebar column. */
export function SidebarSkeleton() {
  return (
    <div className={cn(SIDEBAR_COLUMN_CLASS, "hidden lg:flex")}>
      {[0, 1].map((i) => (
        <div key={i} className="baobab flex flex-col gap-3">
          <Shimmer className="h-5 w-36" />
          <Shimmer className="h-4 w-full" />
          <Shimmer className="h-4 w-2/3" />
        </div>
      ))}
    </div>
  );
}

/**
 * Loading state for the location page and the home page: a structural
 * skeleton of the real page's first screen, so nothing moves when the content
 * arrives (Apple HIG, Launching: make it nearly identical to the first
 * screen; no splash, no branding, no text).
 *
 * - The sky follows the last weather this device cached for the place (the
 *   same hint WeatherDashboard writes); a first visit gets a neutral sky.
 *   The hero is bars on that sky, with no plate colour to get wrong. The hint is read after mount, so hydration never differs.
 * - The header and the floating bottom nav are the persistent app chrome and
 *   are not drawn here; the breadcrumb row keeps its height.
 * - Same frame as WeatherDashboard (`max-w-7xl`, `--space-section`, the
 *   column classes) and the same bottom clearance, so safe areas and the nav
 *   are respected.
 * - Static sky gradient only: no Three.js, no WebGL while the page boots.
 *   Bars shimmer under `prefers-reduced-motion: no-preference` and are
 *   static otherwise.
 * - One polite status region (`role="status"`, `aria-busy`) for assistive
 *   tech; every drawn block is `aria-hidden`.
 */
export function LocationSkeleton({ slug }: { slug?: string | null }) {
  // The home page has no slug in its URL: it shows the place the visitor
  // last picked, so its hint is that place's.
  const [look, setLook] = useState<SkeletonLook>(() => skeletonLook(null));

  // The hint is in localStorage, which the server cannot read: look after
  // mount (deferred a frame, like the other client-only reads).
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const place = slug ?? useAppStore.getState().selectedLocation;
      setLook(skeletonLook(place ? getCachedWeatherHint(place) : null));
    });
    return () => cancelAnimationFrame(id);
  }, [slug]);

  return (
    <>
      <WeatherSky type={look.sceneType} isDay={look.isDay} />
      <div className="relative z-10" data-location-skeleton="">
        <nav
          aria-hidden="true"
          className="mx-auto max-w-7xl px-4 pt-3 sm:px-6 md:px-8"
        >
          <div className="flex items-center gap-1.5 text-base">
            <span className="dik-dik">
              <Shimmer className="h-[0.7em] w-48" />
            </span>
          </div>
        </nav>
        <div
          role="status"
          aria-label="Loading"
          aria-busy="true"
          className="mx-auto max-w-7xl overflow-x-clip px-4 pt-[var(--space-section)] pb-[var(--mobile-nav-clearance)] sm:px-6 sm:pb-6 md:px-8"
        >
          <span className="sr-only">Loading weather</span>
          <div className="grid gap-[var(--space-section)] lg:grid-cols-3 xl:grid-cols-4">
            <div className={`relative ${MAIN_COLUMN_CLASS}`}>
              <HeroSkeleton />
              <HourlyStripSkeleton />
              <TileGridSkeleton />
            </div>
            <SidebarSkeleton />
          </div>
        </div>
      </div>
    </>
  );
}
