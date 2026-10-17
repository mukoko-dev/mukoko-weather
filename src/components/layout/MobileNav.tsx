"use client";

import { List as ListIcon, Map as MapIcon } from "lucide-react";
import { LocationPager } from "@/components/layout/LocationPager";
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

/** Lucide-shaped wrapper so the weather NavigationIcon fits a nav item. */
function MyLocationIcon({ className }: { className?: string }) {
  return <NavigationIcon size={21} className={className} />;
}

/** The three phone destinations, in bar order. */
export function mobileNavItems(
  mapHref: string,
  hasMapLocation: boolean,
): BottomNavItem[] {
  return [
    {
      id: "map",
      label: "Map",
      href: mapHref,
      icon: MapIcon,
      ariaLabel: hasMapLocation
        ? "Weather map"
        : "Choose a location for the weather map",
    },
    {
      id: "my-location",
      label: "My Location",
      href: MY_LOCATION_HREF,
      icon: MyLocationIcon,
    },
    {
      id: "locations",
      label: "Locations",
      href: "/locations",
      icon: ListIcon,
      ariaLabel: "All locations",
    },
  ];
}

/**
 * Which bar item is the current page. Explicit, so the Map item (which
 * points at /explore while no location is on screen) never lights up on
 * Explore; "none" matches no item.
 */
export function mobileNavActiveId(pathname: string): string {
  if (pathname === MY_LOCATION_HREF) return "my-location";
  if (pathname === "/locations") return "locations";
  return "none";
}

/**
 * Phone navigation: the Mzizi registry bottom nav (`MziziBottomNav`,
 * vendored in src/components/ui/mzizi-bottom-nav.tsx) with Map, My Location
 * and Locations. Where you are in your places is the LocationPager row in
 * the bar's `indicator` slot, directly above the items: a My Location
 * glyph and one dot per place, each a real link (48px target, the place's
 * name as its label, `aria-current` on the current one, `location_changed`
 * method "saved" on tap), so keyboard and switch users can reach every
 * place. Swiping left/right on the dashboard (useLocationSwipe) still
 * moves between the same places. With one page the row is not rendered.
 *
 * Page content leaves `--mobile-nav-clearance` at the bottom so nothing sits
 * under the bar; that token is computed from `--mobile-nav-height`, which
 * is the bar (5rem) plus the page row (one touch target), without the safe
 * area.
 */
export function MobileNav({
  pathname,
  savedLocations,
  selectedLocation,
  mapHref,
  hasMapLocation,
}: MobileNavProps) {
  return (
    <MziziBottomNav
      label="Mobile navigation"
      className="sm:hidden"
      activeId={mobileNavActiveId(pathname)}
      items={mobileNavItems(mapHref, hasMapLocation)}
      indicator={
        // The pager is the only part with real logic; if it ever throws,
        // the bar keeps working without it.
        <MziziHarness
          name="location-pager"
          className="flex min-w-0 flex-1 justify-center"
          fallback={<span />}
        >
          <LocationPager
            pathname={pathname}
            savedLocations={savedLocations}
            selectedLocation={selectedLocation}
          />
        </MziziHarness>
      }
    />
  );
}
