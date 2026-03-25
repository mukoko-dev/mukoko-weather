import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Format coordinates with N/S/E/W indicators (e.g., "17.8300°S, 31.0500°E"). */
export function formatCoords(lat: number, lon: number): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(4)}\u00B0${ns}, ${Math.abs(lon).toFixed(4)}\u00B0${ew}`;
}

/**
 * Convert a slug to a human-readable display name.
 * Uppercases 2-letter country code suffixes (sg → SG) and strips
 * numeric collision suffixes (e.g., -14).
 */
export function slugToDisplayName(slug: string): string {
  const parts = slug.split("-");
  // Strip trailing numeric-only segments (slug collision suffixes)
  while (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) {
    parts.pop();
  }
  return parts
    .map((part, i) => {
      // Last part that is exactly 2 chars → country code → uppercase
      if (i === parts.length - 1 && part.length === 2) {
        return part.toUpperCase();
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
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
