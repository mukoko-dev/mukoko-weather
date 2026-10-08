"use client";

import { useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { NavigationIcon } from "@/lib/weather-icons";
import { useAppStore } from "@/lib/store";
import { trackEvent } from "@/lib/analytics";
import { currentLocationSlug, displayNameFromSlug } from "@/lib/current-slug";
import { getScrollBehavior } from "@/lib/utils";
import {
  MY_LOCATION_HREF,
  neighbour,
  pagerDots,
  pagerIndex,
  pagerSequence,
} from "@/lib/location-pager";
import { useSwipe } from "@/lib/use-swipe";

/**
 * Page indicator for the mobile bottom bar, and the swipe gesture that walks
 * the same sequence. Both read `savedLocations` and the pathname, so the dots
 * and the swipe can never disagree about what the next page is.
 */

const PAGE_ITEM_CLASS =
  "flex h-[var(--touch-target-min)] min-w-[var(--touch-target-min)] shrink-0 items-center justify-center rounded-full transition-colors active:scale-95";

interface LocationPagerProps {
  pathname: string;
  savedLocations: readonly string[];
  selectedLocation: string;
}

/**
 * Centre pill of the bottom bar: a location-arrow glyph for My Location, then
 * one dot per saved location, the current page's dot highlighted. Tapping
 * navigates. Overflow scrolls sideways and keeps the active item in view.
 */
export function LocationPager({
  pathname,
  savedLocations,
  selectedLocation,
}: LocationPagerProps) {
  const from = currentLocationSlug(pathname, selectedLocation) ?? "";
  const sequence = useMemo(
    () => pagerSequence(savedLocations),
    [savedLocations],
  );
  const activeIndex = pagerIndex(pathname, sequence);
  const dots = pagerDots(sequence);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);

  // Keep the current page's item centred in the pill when it overflows.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const active = activeRef.current;
    if (!scroller || !active) return;
    const left =
      active.offsetLeft - (scroller.clientWidth - active.offsetWidth) / 2;
    scroller.scrollTo({
      left: Math.max(0, left),
      behavior: getScrollBehavior(),
    });
  }, [activeIndex]);

  return (
    <nav aria-label="Location pages" className="min-w-0 flex-1">
      <div
        ref={scrollerRef}
        className="scrollbar-hide relative flex h-[var(--touch-target-min)] items-center overflow-x-auto rounded-full border border-text-tertiary/10 bg-surface-card/80 px-1 shadow-sm"
      >
        <ul className="flex items-center">
          <li className="shrink-0">
            <Link
              href={MY_LOCATION_HREF}
              prefetch={false}
              ref={activeIndex === 0 ? activeRef : undefined}
              aria-label="My Location"
              aria-current={activeIndex === 0 ? "page" : undefined}
              className={`${PAGE_ITEM_CLASS} ${
                activeIndex === 0
                  ? "text-primary"
                  : "text-text-tertiary hover:text-text-secondary"
              }`}
            >
              <NavigationIcon size={18} />
            </Link>
          </li>
          {dots.map((href) => {
            const slug = href.slice(1);
            const name = displayNameFromSlug(slug);
            const index = sequence.indexOf(href);
            const isActive = index === activeIndex;
            return (
              <li key={href} className="shrink-0">
                <Link
                  href={href}
                  prefetch={false}
                  ref={isActive ? activeRef : undefined}
                  aria-label={name}
                  title={name}
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => trackPageChange(href, slug, from)}
                  className={PAGE_ITEM_CLASS}
                >
                  <span
                    aria-hidden="true"
                    className={`block h-2 w-2 rounded-full transition-colors ${
                      isActive ? "bg-primary" : "bg-text-tertiary/50"
                    }`}
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}

/** Analytics for a page change to a saved location. Home is not a saved slug. */
function trackPageChange(href: string, slug: string, from: string) {
  if (href === MY_LOCATION_HREF) return;
  trackEvent("location_changed", { from, to: slug, method: "saved" });
}

/**
 * Swipe handlers for the location dashboard: left goes to the next page in the
 * pager sequence, right to the previous one. Stops at either end. `enabled`
 * lets callers switch the gesture off (e.g. while reordering sections).
 */
export function useLocationSwipe({
  enabled = true,
}: { enabled?: boolean } = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const savedLocations = useAppStore((s) => s.savedLocations);
  const selectedLocation = useAppStore((s) => s.selectedLocation);

  const step = (dir: 1 | -1) => {
    const sequence = pagerSequence(savedLocations);
    const target = neighbour(sequence, pagerIndex(pathname, sequence), dir);
    if (!target) return;
    trackPageChange(
      target,
      target.slice(1),
      currentLocationSlug(pathname, selectedLocation) ?? "",
    );
    router.push(target);
  };

  return useSwipe({
    enabled,
    onSwipeLeft: () => step(1),
    onSwipeRight: () => step(-1),
  });
}
