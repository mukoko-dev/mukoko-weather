"use client";

import { useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAppStore } from "@/lib/store";
import { trackEvent } from "@/lib/analytics";
import { currentLocationSlug } from "@/lib/current-slug";
import {
  MY_LOCATION_HREF,
  neighbour,
  pagerIndex,
  pagerSequence,
} from "@/lib/location-pager";
import { useSwipe } from "@/lib/use-swipe";
import { navigateToPlace } from "@/lib/place-bus";
import { visiblePresetSlugs } from "@/lib/location-presets";

/**
 * The hooks behind moving between the visitor's places: the one page sequence
 * (My Location, saved places, visible suggested places) and the swipe gesture
 * that walks it. The bottom bar's places lane (components/layout/PlaceLane.tsx)
 * reads the same sequence, so a tap on a chip and a swipe can never disagree
 * about what the next page is.
 */

/** Analytics for a page change to a saved location. Home is not a saved slug. */
export function trackPlaceChange(href: string, slug: string, from: string) {
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
  const sequence = usePagerSequence(savedLocations, selectedLocation);

  const step = (dir: 1 | -1) => {
    const target = neighbour(sequence, pagerIndex(pathname, sequence), dir);
    if (!target) return;
    trackPlaceChange(
      target,
      target.slice(1),
      currentLocationSlug(pathname, selectedLocation) ?? "",
    );
    // In place when a place stage is mounted (state + pushState); the
    // router only when it is not or cannot show the place.
    navigateToPlace(target, (href) => router.push(href));
  };

  return useSwipe({
    enabled,
    onSwipeLeft: () => step(1),
    onSwipeRight: () => step(-1),
  });
}

/**
 * The page sequence the lane's chips and the swipe both walk: the single
 * source. Saved places, then the visible suggested places, in the order
 * `pagerSequence` defines. Both PlaceLane and useLocationSwipe call this
 * hook; neither computes the sequence itself.
 */
export function usePagerSequence(
  savedLocations: readonly string[],
  selectedLocation: string,
): string[] {
  const hiddenPresetSlugs = useAppStore((s) => s.hiddenPresetSlugs);
  const presetAnchor = useAppStore((s) => s.presetAnchor);
  return useMemo(
    () =>
      pagerSequence(
        savedLocations,
        visiblePresetSlugs({
          anchor: presetAnchor,
          hidden: hiddenPresetSlugs,
          saved: savedLocations,
          current: selectedLocation,
        }),
      ),
    [savedLocations, hiddenPresetSlugs, presetAnchor, selectedLocation],
  );
}
