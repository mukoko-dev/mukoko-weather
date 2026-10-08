/**
 * Pure helpers for the iOS-style centred hero (CurrentConditions).
 *
 * Kept free of React and the store so the eyebrow selection and the
 * high/low formatting can be unit-tested in Node.
 */

/** Eyebrow badges shown above the place name, in display order. */
export type HeroBadge = "current" | "home";

/**
 * Which eyebrow badges to show above the place name.
 *
 * - current location only  -> ["current"]   (➤ MY LOCATION)
 * - home only              -> ["home"]      (⌂ HOME)
 * - both                   -> ["current", "home"]
 * - neither                -> []            (no eyebrow)
 */
export function heroEyebrowBadges(
  isCurrentLocation: boolean,
  isHome: boolean,
): HeroBadge[] {
  const badges: HeroBadge[] = [];
  if (isCurrentLocation) badges.push("current");
  if (isHome) badges.push("home");
  return badges;
}

/** Uppercase-friendly label for an eyebrow badge (CSS applies the caps). */
export function heroBadgeLabel(badge: HeroBadge): string {
  return badge === "current" ? "My Location" : "Home";
}

/**
 * True when the place being shown is the visitor's saved home place.
 * `homeLocation` is a location slug (or null when no home is set).
 */
export function isHomeLocation(
  slug: string | undefined,
  homeLocation: string | null | undefined,
): boolean {
  return Boolean(slug) && Boolean(homeLocation) && slug === homeLocation;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Formats today's high/low as the hero line, e.g. "H:34°  L:25°".
 * Returns null when either value is missing or not a finite number, so the
 * hero never renders "H:NaN°" (the daily arrays can be empty).
 */
export function formatHighLow(
  high: number | null | undefined,
  low: number | null | undefined,
): string | null {
  if (!isFiniteNumber(high) || !isFiniteNumber(low)) return null;
  return `H:${Math.round(high)}°  L:${Math.round(low)}°`;
}
