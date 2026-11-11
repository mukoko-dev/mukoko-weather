"use client";

import Link from "next/link";
import { Map as MapIcon, User as UserIcon } from "lucide-react";
import { PhoneMenu } from "@/components/layout/PhoneMenu";
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
 * The one pinned phone destination: Map at the start edge. My Location is the
 * lane's first chip, the account control is the lane's last slot, and
 * Locations is a round link at the top of the page; none of them is an item.
 */
export function mobileNavItems(
  mapHref: string,
  hasMapLocation: boolean,
): { leading: BottomNavItem[] } {
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
  };
}

/**
 * The account control's look in the bar: a round `.plover` target (the pinned
 * items' hairline border and muted fill, and their tap area, the bar's whole
 * height), one touch target wide, so it reads as a sibling of the lane's chips.
 * `PhoneMenu` hands it to the Mzizi account menu as its trigger, which crops a
 * profile photo to the circle.
 */
export const ACCOUNT_SLOT_CLASS =
  "plover press-scale relative flex size-[var(--touch-target-min)] shrink-0 items-center justify-center rounded-full text-foreground";

/**
 * What the account slot shows if the menu ever throws: a plain link to the
 * profile page (which sends a visitor who is signed out to sign-in), so the
 * bar can always reach the account.
 */
function AccountFallback() {
  return (
    <Link
      href="/profile"
      prefetch={false}
      aria-label="Account"
      className={ACCOUNT_SLOT_CLASS}
    >
      <UserIcon size={20} aria-hidden="true" />
    </Link>
  );
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
      className="lark press-scale min-w-[var(--touch-target-min)]"
    >
      <NavigationIcon size={18} />
    </Link>
  );
}

/**
 * Phone navigation: ONE floating bar (option B, owner 2026-11-02). The Mzizi
 * registry bottom nav (`MziziBottomNav`, vendored in
 * src/components/ui/mzizi-bottom-nav.tsx) with Map pinned at the start and the
 * lane filling the rest. The lane is the places lane (PlaceLane): My Location
 * first and pinned (the second control from the left, owner 2026-11-11), then
 * one chip per saved place, scrolling sideways; each chip is a real link (49px
 * target, the place's name as its label, `aria-current` on the current one,
 * `location_changed` method "saved" on tap) that switches place in place.
 * The lane ends with the ACCOUNT control, at the far right (owner, 2026-11-11):
 * the Mzizi account menu's round trigger, which opens its menu upward from the
 * bar (PhoneMenu). Locations is not in the bar: it is the round list link at the
 * top right of the page (LocationsLink). Swiping left/right on the dashboard
 * (useLocationSwipe) moves between the same places, My Location first. There is
 * no second pill above the bar.
 *
 * Page content leaves `--mobile-nav-clearance` at the bottom so nothing sits
 * under the bar; that token is the bar (4.5rem) plus the lift, the safe area
 * and a breath.
 */
export function MobileNav({
  savedLocations,
  selectedLocation,
  pathname,
  mapHref,
  hasMapLocation,
}: MobileNavProps) {
  const { leading } = mobileNavItems(mapHref, hasMapLocation);
  return (
    <MziziBottomNav
      label="Mobile navigation"
      className="sm:hidden"
      // No pinned item is ever "current": the lane marks its own chip, and the
      // Map item must not light up on Explore, where it points at /explore.
      activeId="none"
      leading={leading}
      lane={
        <div className="flex h-full min-w-0 flex-1 items-center justify-center gap-[var(--float-gap)]">
          {/* The lane is the only part with real logic; if it ever throws, the
              bar keeps Map, the account control and a plain My Location link.
              Each part has its own boundary: a crash in one leaves the other. */}
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
          {/* The account menu's panel hangs from the bar (`<nav>` is the
              positioned ancestor, see app-account-menu.tsx change 13), so
              nothing between it and the bar may be positioned or clipped. */}
          <MziziHarness
            name="account-menu"
            className="flex shrink-0 items-center"
            fallback={<AccountFallback />}
          >
            <PhoneMenu buttonClassName={ACCOUNT_SLOT_CLASS} />
          </MziziHarness>
        </div>
      }
    />
  );
}
