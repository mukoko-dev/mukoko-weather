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

/** True while the root layout's persistent chrome is on screen. */
export const ChromeContext = createContext(false);

/** Whether the layout already renders the header and bottom nav. */
export function useChromeClaimed(): boolean {
  return useContext(ChromeContext);
}
