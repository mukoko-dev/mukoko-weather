"use client";

import { useSyncExternalStore } from "react";
import { canInstall, subscribeInstall } from "@/lib/install-app";

/**
 * True when this browser can install the app from the page right now (see
 * src/lib/install-app.ts). False on the server, so the first render matches
 * the HTML, and false when the app is already installed.
 */
export function useCanInstall(): boolean {
  return useSyncExternalStore(subscribeInstall, canInstall, () => false);
}
