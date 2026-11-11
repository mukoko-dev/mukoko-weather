"use client";

import { createContext, useContext } from "react";

/**
 * Routes that take the whole viewport and carry their own controls: the
 * weather map (`/{slug}/map`) and the wall display (`/display`). The site
 * chrome stays away from them.
 */
const IMMERSIVE_PATHS: readonly RegExp[] = [/^\/[^/]+\/map$/, /^\/display$/];

export function isImmersivePath(pathname: string): boolean {
  return IMMERSIVE_PATHS.some((re) => re.test(pathname));
}

/**
 * Where the Quick actions group (Share, Notifications, Locations) is never
 * drawn: the iframe views under `/embed/` (the weather widget lives inside
 * other people's pages, where a fixed group that shares the iframe's own
 * address would be wrong) and the wall display, a kiosk nobody taps. The
 * embed's header and footer are not touched by this: only the group is left
 * out. `/embed` itself (the page that explains the widget) is an ordinary
 * page and has the group.
 */
const NO_QUICK_ACTIONS_PATHS: readonly RegExp[] = [
  /^\/embed\/.+/,
  /^\/display$/,
];

/**
 * Whether the site chrome draws the Quick actions group on this path.
 *
 * Who draws it is not decided here, and never by a path: whatever renders the
 * site header draws the group with it (SiteHeader, wherever it is rendered:
 * by AppChrome, or by a page's own `<Header />` where AppChrome has stood
 * back), and the one page that takes the whole screen without a header, the
 * weather map, draws its own (MapDashboard and its loader). A page that shows
 * no header (a route's error boundary under the map) shows no group. So the
 * group can never be drawn twice by two owners that read the path differently.
 */
export function showsQuickActions(pathname: string): boolean {
  return !NO_QUICK_ACTIONS_PATHS.some((re) => re.test(pathname));
}

/** True while the root layout's persistent chrome is on screen. */
export const ChromeContext = createContext(false);

/** Whether the layout already renders the header and bottom nav. */
export function useChromeClaimed(): boolean {
  return useContext(ChromeContext);
}
