/**
 * What the site header offers, as data, so the desktop header and the phone
 * menu (`PhoneMenu`) can never drift apart: the text-nav destinations, the
 * weather-map link and the notifications copy live here once.
 *
 * Pure (no React, no store): the header and the menu pass in the pathname,
 * the current place slug and the feature-flag lookup.
 */

import type { FLAGS } from "@/lib/feature-flags";
import { navDestination, type NavDestinationId } from "@/lib/nav-destinations";

export interface HeaderDestination {
  href: string;
  label: string;
  /** Shown only while this feature flag is on (Shamwari is paused). */
  flag?: keyof typeof FLAGS;
}

/**
 * A header entry for a destination in `lib/nav-destinations` (the one list of
 * routes, labels and hrefs the header, footer, profile and `/locations` menu
 * all read): only the order and the flag are decided here.
 */
function headerDestination(
  id: NavDestinationId,
  flag?: keyof typeof FLAGS,
): HeaderDestination {
  const { href, label } = navDestination(id);
  return flag ? { href, label, flag } : { href, label };
}

/** The header's text-nav destinations, in display order. */
export const HEADER_DESTINATIONS: readonly HeaderDestination[] = [
  headerDestination("explore"),
  headerDestination("shamwari", "shamwari_chat"),
  headerDestination("history"),
  headerDestination("aviation"),
];

/** The destinations visible right now (flagged ones only while enabled). */
export function visibleHeaderDestinations(
  isEnabled: (flag: keyof typeof FLAGS) => boolean,
): HeaderDestination[] {
  return HEADER_DESTINATIONS.filter((d) => !d.flag || isEnabled(d.flag));
}

/** Whether `pathname` is on (or under, for Explore) a destination. */
export function isDestinationActive(pathname: string, href: string): boolean {
  if (href === "/explore") {
    return pathname === "/explore" || pathname.startsWith("/explore/");
  }
  return pathname === href;
}

/**
 * The weather map for the place on screen; with no real place yet, Explore so
 * the visitor can pick one rather than being sent to a guessed city.
 */
export function weatherMapHref(slug: string | null): string {
  return slug ? `/${slug}/map` : "/explore";
}

/** What the bell shows (there are no notifications yet). */
export const NOTIFICATIONS_EMPTY_TEXT = "No notifications yet";
