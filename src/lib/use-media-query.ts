"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether a CSS media query matches, kept current. The server render and the
 * hydration render are always `false`, so a component that branches on it
 * should render the branch only after it opened (client-only content), as the
 * notifications centre does.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) {
        return () => {};
      }
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () =>
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia(query).matches
        : false,
    () => false,
  );
}

/** The phone layout: below Tailwind's `sm` (640px). */
export const PHONE_QUERY = "(max-width: 639px)";
