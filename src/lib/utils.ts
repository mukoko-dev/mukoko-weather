import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Returns the appropriate scroll behavior based on the user's
 * prefers-reduced-motion setting. CSS media queries don't affect
 * JS `scrollIntoView` — must check via `matchMedia`.
 */
export function getScrollBehavior(): ScrollBehavior {
  return typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "instant"
    : "smooth";
}
