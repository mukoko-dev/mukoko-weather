"use client";

import { useEffect } from "react";
import type { DashboardPayload } from "./device-weather";
import { rememberHomeSnapshot } from "./home-snapshot";

/**
 * Keep the forecast on screen for My Location, so the next open can paint it
 * before IndexedDB has started (src/lib/home-snapshot.ts). Only while the place
 * on screen is the one `/` shows (`isHome`): a place page or a place the visitor
 * only looked at never becomes it. `fetchedAt` is the age of a forecast read
 * back from the device (omit it for one just fetched), so an old copy is never
 * dressed up as new. The seasonal estimate is never kept (the store refuses it).
 */
export function useRememberHomeSnapshot(
  view: DashboardPayload | null,
  fetchedAt: number | undefined,
  isHome: boolean,
): void {
  useEffect(() => {
    if (isHome && view) rememberHomeSnapshot(view, fetchedAt);
  }, [isHome, view, fetchedAt]);
}
