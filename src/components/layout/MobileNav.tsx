"use client";

import Link from "next/link";
import {
  List as ListIcon,
  Map as MapIcon,
  User as UserIcon,
} from "lucide-react";
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
 * The two pinned phone destinations: Map at the start edge, Locations at the
 * end. The account control is the lane's first slot; My Location is a round
 * link at the top of the page, neither is an item.
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
 * Explore; "none" matches no item. The lane marks its own current chip (a
 * place on its page), so no pinned item is current there.
 */
export function mobileNavActiveId(pathname: string): string {
  return pathname === "/locations" ? "locations" : "none";
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
 * src/components/ui/mzizi-bottom-nav.tsx) with Map pinned at the start, the
 * lane in the middle and Locations pinned at the end. The lane starts with the
 * ACCOUNT control (owner, 2026-11-05: the avatar and My Location swapped
 * places): the Mzizi account menu's round trigger, pinned, which opens its
 * menu upward from the bar (PhoneMenu). Then the places lane (PlaceLane): one
 * chip per saved place, scrolling sideways; each chip is a real link (49px
 * target, the place's name as its label, `aria-current` on the current one,
 * `location_changed` method "saved" on tap) that switches place in place.
 * My Location, formerly the lane's first chip, is the round arrow link in the
 * hero's top group and the header's pill (MyLocationLink). Swiping left/right
 * on the dashboard (useLocationSwipe) moves between the same places, My
 * Location first. There is no second pill above the bar.
 *
 * Page content leaves `--mobile-nav-clearance` at the bottom so nothing sits
 * under the bar; that token is the bar (4.5rem) plus the lift, the safe area
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
        <div className="flex h-full min-w-0 flex-1 items-center justify-center gap-[var(--float-gap)]">
          {/* The account menu's panel hangs from the bar (`<nav>` is the
              positioned ancestor, see app-account-menu.tsx change 13), so
              nothing between it and the bar may be positioned or clipped. Each
              part has its own boundary: a crash in one leaves the other. */}
          <MziziHarness
            name="account-menu"
            className="flex shrink-0 items-center"
            fallback={<AccountFallback />}
          >
            <PhoneMenu buttonClassName={ACCOUNT_SLOT_CLASS} />
          </MziziHarness>
          {/* The lane is the only part with real logic; if it ever throws, the
              bar keeps Map, Locations, the account control and a plain My
              Location link. With no places it renders nothing and `empty:hidden`
              lets the account control sit centred. */}
          <MziziHarness
            name="place-lane"
            className="flex h-full min-w-0 flex-1 items-center empty:hidden"
            fallback={<LaneFallback />}
          >
            <PlaceLane
              pathname={pathname}
              savedLocations={savedLocations}
              selectedLocation={selectedLocation}
            />
          </MziziHarness>
        </div>
      }
    />
  );
}
