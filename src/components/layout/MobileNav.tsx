"use client";

import Link from "next/link";
import { List as ListIcon, Map as MapIcon } from "lucide-react";
import { LocationPager } from "@/components/layout/LocationPager";
import { NavigationIcon } from "@/lib/weather-icons";
import { MziziHarness } from "@/lib/harness";
import { MY_LOCATION_HREF } from "@/lib/location-pager";

/** Icon size for the island's end slots — one size and weight everywhere. */
export const NAV_ICON_SIZE = 22;

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
 * The floating navigation island on phones: `[ Map | page dots | List ]`.
 *
 * Same shape as the mukoko-news island — a centred pill lifted off the edge
 * by the safe-area inset (`.lourie`), fixed ends and a contextual middle —
 * rather than a bar welded to the bottom of the browser viewport. The ends
 * never move between pages; the middle is the location pager. One surface:
 * the slots carry no borders or backgrounds of their own, so the island
 * reads as a single object, not three pills inside a bar.
 *
 * Page content leaves `--mobile-nav-clearance` at the bottom so nothing sits
 * under it; that token is computed from the same `--mobile-nav-*` geometry.
 */
export function MobileNav({
  pathname,
  savedLocations,
  selectedLocation,
  mapHref,
  hasMapLocation,
}: MobileNavProps) {
  const isLocationList = pathname === "/locations";
  return (
    <nav
      aria-label="Mobile navigation"
      data-slot="mobile-nav"
      className="lourie sm:hidden"
    >
      <Link
        href={mapHref}
        prefetch={false}
        aria-label={
          hasMapLocation
            ? "Weather map"
            : "Choose a location for the weather map"
        }
        className="duiker"
      >
        <MapIcon size={NAV_ICON_SIZE} aria-hidden="true" />
      </Link>
      <span aria-hidden="true" className="h-6 w-px shrink-0 bg-border" />
      {/* The pager is the only part with real logic; if it ever throws,
            the island keeps a working My Location link instead of a hole. */}
      <MziziHarness
        name="location-pager"
        className="flex min-w-0 flex-1 justify-center"
        fallback={
          <Link
            href={MY_LOCATION_HREF}
            prefetch={false}
            aria-label="My Location"
            className="duiker"
          >
            <NavigationIcon size={NAV_ICON_SIZE - 4} />
          </Link>
        }
      >
        <LocationPager
          pathname={pathname}
          savedLocations={savedLocations}
          selectedLocation={selectedLocation}
        />
      </MziziHarness>
      <span aria-hidden="true" className="h-6 w-px shrink-0 bg-border" />
      <Link
        href="/locations"
        prefetch={false}
        aria-label="All locations"
        aria-current={isLocationList ? "page" : undefined}
        className="duiker"
      >
        <ListIcon size={NAV_ICON_SIZE} aria-hidden="true" />
      </Link>
    </nav>
  );
}
