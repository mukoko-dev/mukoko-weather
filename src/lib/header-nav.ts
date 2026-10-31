/**
 * What the site header offers, as data, so the desktop header and the phone
 * menu (`PhoneMenu`) can never drift apart: the text-nav destinations, the
 * weather-map link and the notifications copy live here once.
 *
 * Pure (no React, no store): the header and the menu pass in the pathname,
 * the current place slug and the feature-flag lookup.
 */

import type { FLAGS } from "@/lib/feature-flags";

export interface HeaderDestination {
  href: string;
  label: string;
  /** Shown only while this feature flag is on (Shamwari is paused). */
  flag?: keyof typeof FLAGS;
}

/** The header's text-nav destinations, in display order. */
export const HEADER_DESTINATIONS: readonly HeaderDestination[] = [
  { href: "/explore", label: "Explore" },
  { href: "/shamwari", label: "Shamwari", flag: "shamwari_chat" },
  { href: "/history", label: "History" },
  { href: "/aviation", label: "Aviation" },
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
