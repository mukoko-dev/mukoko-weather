"use client";

import Link from "next/link";
import { List as ListIcon, Map as MapIcon } from "lucide-react";
import { PlaceLane } from "@/components/layout/PlaceLane";
import {
  MziziBottomNav,
  type BottomNavItem,
} from "@/components/ui/mzizi-bottom-nav";
import { NavigationIcon } from "@/lib/weather-icons";
import { MziziHarness } from "@/lib/harness";
import { MY_LOCATION_HREF } from "@/lib/location-pager";

interface MobileNavProps {
  pathname: string;
  savedLocations: readonly string[];
  selectedLocation: string;
  /** Map route for the location on screen, or Explore when there is none. */
  mapHref: string;
  /** False when no real location is on screen yet. */
  hasMapLocation: boolean;
}

/**
 * The two pinned phone destinations: Map at the start edge, Locations at the
 * end. My Location is the places lane's pinned first chip, not an item.
 */
export function mobileNavItems(
  mapHref: string,
  hasMapLocation: boolean,
): { leading: BottomNavItem[]; trailing: BottomNavItem[] } {
  return {
    leading: [
      {
        id: "map",
        label: "Map",
        href: mapHref,
        icon: MapIcon,
        ariaLabel: hasMapLocation
          ? "Weather map"
          : "Choose a location for the weather map",
      },
    ],
    trailing: [
      {
        id: "locations",
        label: "Locations",
        href: "/locations",
        icon: ListIcon,
        ariaLabel: "All locations",
      },
    ],
  };
}

/**
 * Which pinned bar item is the current page. Explicit, so the Map item (which
 * points at /explore while no location is on screen) never lights up on
 * Explore; "none" matches no item. `/` is My Location, which is the lane's
 * first chip (PlaceLane marks it), so no pinned item matches there either.
 */
export function mobileNavActiveId(pathname: string): string {
  if (pathname === MY_LOCATION_HREF) return "my-location";
  if (pathname === "/locations") return "locations";
  return "none";
}

/**
 * What the lane shows if it ever throws: a plain My Location link, so the
 * bar can always get back to the current-location page.
 */
function LaneFallback() {
  return (
    <Link
      href={MY_LOCATION_HREF}
      prefetch={false}
      aria-label="My Location"
      className="lark min-w-[var(--touch-target-min)] px-0"
    >
      <NavigationIcon size={18} />
    </Link>
  );
}

/**
 * Phone navigation: ONE floating bar (option B, owner 2026-11-02). The Mzizi
 * registry bottom nav (`MziziBottomNav`, vendored in
 * src/components/ui/mzizi-bottom-nav.tsx) with Map pinned at the start, the
 * places lane in the middle and Locations pinned at the end. The lane
 * (PlaceLane) is My Location first and pinned, then one chip per saved
 * place, scrolling sideways behind it; each chip is a real link (48px target,
 * the place's name as its label, `aria-current` on the current one,
 * `location_changed` method "saved" on tap) that switches place in place.
 * Swiping left/right on the dashboard (useLocationSwipe) moves between the
 * same places. There is no second pill above the bar.
 *
 * Page content leaves `--mobile-nav-clearance` at the bottom so nothing sits
 * under the bar; that token is the bar (4rem) plus the lift, the safe area
 * and a breath.
 */
export function MobileNav({
  pathname,
  savedLocations,
  selectedLocation,
  mapHref,
  hasMapLocation,
}: MobileNavProps) {
  const { leading, trailing } = mobileNavItems(mapHref, hasMapLocation);
  return (
    <MziziBottomNav
      label="Mobile navigation"
      className="sm:hidden"
      activeId={mobileNavActiveId(pathname)}
      leading={leading}
      trailing={trailing}
      lane={
        // The lane is the only part with real logic; if it ever throws, the
        // bar keeps Map and Locations and a plain My Location link.
        <MziziHarness
          name="place-lane"
          className="flex h-full min-w-0 flex-1 items-center"
          fallback={<LaneFallback />}
        >
          <PlaceLane
            pathname={pathname}
            savedLocations={savedLocations}
            selectedLocation={selectedLocation}
          />
        </MziziHarness>
      }
    />
  );
}
