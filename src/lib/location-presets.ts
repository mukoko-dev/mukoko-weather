/**
 * Suggested places ("presets") for the Locations list and the pager.
 *
 * A visitor sees a few seeded cities near them before saving anything. Each
 * one can be hidden; hiding is persisted (`hiddenPresetSlugs`) and restored
 * in one action. The anchor is the visitor's rough position (IP geo on first
 * visit), persisted as `presetAnchor`, so the suggestions are deterministic
 * and need no network call.
 *
 * Pure: no DOM, store or network. The list page and the bottom-bar pager both
 * call `visiblePresetSlugs` with the same inputs, so they show the same places
 * in the same order.
 */

import { LOCATIONS, type WeatherLocation } from "@/lib/locations";
import { isLocationSlug } from "@/lib/current-slug";

/** Nearest seeded cities suggested around the anchor (Harare and Bulawayo are added on top). */
export const PRESET_NEAREST_COUNT = 4;

/** Always-suggested seeded cities, listed after the nearest ones. */
export const PRESET_ALWAYS_SLUGS: readonly string[] = ["harare", "bulawayo"];

export interface PresetAnchor {
  lat: number;
  lon: number;
}

/** Great-circle distance in kilometres (haversine, mean Earth radius). */
export function haversineKm(a: PresetAnchor, b: PresetAnchor): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** True when the value is a usable anchor (finite, within WGS 84 bounds). */
export function isPresetAnchor(value: unknown): value is PresetAnchor {
  if (!value || typeof value !== "object") return false;
  const { lat, lon } = value as Record<string, unknown>;
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/**
 * Ordered suggestion list for an anchor: the nearest seeded cities (closest
 * first, ties broken by slug), then Harare and Bulawayo. Without an anchor
 * only Harare and Bulawayo are suggested. Duplicates never appear.
 */
export function suggestPresetSlugs(
  anchor: PresetAnchor | null | undefined,
  seeds: readonly WeatherLocation[] = LOCATIONS,
): string[] {
  const always = PRESET_ALWAYS_SLUGS.filter((slug) =>
    seeds.some((loc) => loc.slug === slug),
  );
  if (!isPresetAnchor(anchor)) return [...always];

  const nearest = seeds
    .filter((loc) => !always.includes(loc.slug))
    .map((loc) => ({
      slug: loc.slug,
      km: haversineKm(anchor, { lat: loc.lat, lon: loc.lon }),
    }))
    .sort((a, b) => a.km - b.km || a.slug.localeCompare(b.slug))
    .slice(0, PRESET_NEAREST_COUNT)
    .map((item) => item.slug);

  return [...nearest, ...always];
}

export interface VisiblePresetInput {
  anchor: PresetAnchor | null | undefined;
  /** Slugs the visitor has hidden (`hiddenPresetSlugs`). */
  hidden: readonly string[] | null | undefined;
  /** Saved slugs: a saved place is never repeated as a preset. */
  saved: readonly string[] | null | undefined;
  /** The current location (My Location): not repeated as a preset either. */
  current: string | null | undefined;
  /** Override the suggestion list (tests). Defaults to `suggestPresetSlugs(anchor)`. */
  suggested?: readonly string[];
}

/**
 * Presets the visitor currently sees: the suggestions minus hidden places,
 * saved places and the current location. Only real location slugs pass.
 */
export function visiblePresetSlugs(input: VisiblePresetInput): string[] {
  const suggested = input.suggested ?? suggestPresetSlugs(input.anchor);
  const hidden = new Set(input.hidden ?? []);
  const taken = new Set<string>([
    ...(input.saved ?? []),
    ...(input.current ? [input.current] : []),
  ]);
  const out: string[] = [];
  for (const slug of suggested) {
    if (!isLocationSlug(slug)) continue;
    if (hidden.has(slug) || taken.has(slug) || out.includes(slug)) continue;
    out.push(slug);
  }
  return out;
}

/** Suggested places that the visitor has hidden (drives "Restore suggested places"). */
export function hiddenSuggestedSlugs(
  anchor: PresetAnchor | null | undefined,
  hidden: readonly string[] | null | undefined,
): string[] {
  const hiddenSet = new Set(hidden ?? []);
  return suggestPresetSlugs(anchor).filter((slug) => hiddenSet.has(slug));
}
