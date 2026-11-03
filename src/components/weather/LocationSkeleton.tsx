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

/** Hour tiles in the Conditions card skeleton (the real strip scrolls past these). */
export const HOURLY_PLACEHOLDER_COUNT = 8;
/** Square tiles in the Conditions grid skeleton (2 rows of 2, one row of 4). */
export const TILE_PLACEHOLDER_COUNT = 4;

/**
 * Typical copy, laid out invisibly to give the placeholder its real height at
 * every width. Sentence and note lengths are the middle of what the page
 * shows: the hourly outlook is one or two clauses (around 80 characters), a
 * season note is 19 to 51 characters (median 37, src/lib/seed-seasons.ts).
 * Never drawn and `aria-hidden` with the rest of the skeleton.
 */
export const TYPICAL_OUTLOOK =
  "Clear conditions will continue for the next 12 hours. Wind gusts are up to 31 km/h.";
export const TYPICAL_SEASON_NOTE = "Warming temperatures, early rains possible";

/**
 * One bar per wrapped line of the outlook: the shimmer fills the paragraph's
 * text box and a repeating mask (period 1.625em, the line height) keeps a
 * 0.7em bar per line. Both the standard and the `-webkit-` property, since
 * the arbitrary values are not prefixed for us.
 */
const OUTLOOK_BARS_CLASS =
  "absolute top-0 right-[8%] bottom-3 left-0 [-webkit-mask-image:repeating-linear-gradient(to_bottom,transparent_0,transparent_0.45em,currentColor_0.45em,currentColor_1.15em,transparent_1.15em,transparent_1.625em)] [mask-image:repeating-linear-gradient(to_bottom,transparent_0,transparent_0.45em,currentColor_0.45em,currentColor_1.15em,transparent_1.15em,transparent_1.625em)]";

/**
 * The Conditions card under the hero: the same `.kestrel-card` box, heading
 * row, outlook lines, hour tiles and season footer as `HourlyScrollCards`
 * (variant "sky"), with bars where the text goes.
 */
export function ConditionsCardSkeleton() {
  return (
    <section aria-hidden="true" data-skeleton="conditions">
      <div className="kestrel-card overflow-hidden">
        <div className="flex min-h-[var(--touch-target-min)] items-center justify-between gap-2">
          <h2 className="giraffe">
            <Shimmer className="h-[0.7em] w-24" />
          </h2>
          <Shimmer className="h-4 w-28" />
        </div>
        {/* The outlook sentence: a typical one laid out invisibly, so it wraps
            at the card's real width exactly as the sentence does (2 lines on a
            393 wide phone, 3 on a 375 one, 1 from `md`); one quiet bar per
            wrapped line is drawn over it by a repeating mask of one line
            height (1.625em, `leading-relaxed`). */}
        <p className="relative mt-1 border-b border-border pb-3 text-base leading-relaxed">
          <span className="invisible">{TYPICAL_OUTLOOK}</span>
          <Shimmer className={OUTLOOK_BARS_CLASS} />
        </p>
        <div className="mt-3 flex gap-2.5 pb-2" data-skeleton="hours">
          {Array.from({ length: HOURLY_PLACEHOLDER_COUNT }, (_, i) => (
            <div
              key={i}
              className="flex min-w-[60px] flex-col items-center gap-1.5 rounded-[var(--radius-input)] px-2.5 py-2"
            >
              <span className="text-base font-normal">
                <Shimmer className="h-[0.7em] w-9" />
              </span>
              <Shimmer className="size-5 rounded-full" />
              <span className="text-base font-semibold">
                <Shimmer className="h-[0.7em] w-7" />
              </span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-center border-t border-border pt-3">
          {/* Sized like the season line: a name and a description that wraps
              (hidden text, not drawn), so the card has its usual height. */}
          <Shimmer className="inline-flex max-w-full flex-wrap items-center justify-center gap-x-2 rounded-[var(--radius-badge)] px-3 py-1 text-center">
            <span className="invisible text-base font-semibold">
              Wet season
            </span>
            <span className="invisible text-base font-normal">
              {TYPICAL_SEASON_NOTE}
            </span>
          </Shimmer>
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
 *   are not drawn here; the hero's own top row (breadcrumb bar, round
 *   controls) is part of the hero placeholder, and `data-sky-hero` hides the
 *   phone header exactly as the real hero does.
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
      <WeatherSky family={look.family} texture={look.texture} />
      <div className="relative z-10" data-location-skeleton="">
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
              <ConditionsCardSkeleton />
              <TileGridSkeleton />
            </div>
            <SidebarSkeleton />
          </div>
        </div>
      </div>
    </>
  );
}
