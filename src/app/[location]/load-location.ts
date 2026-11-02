import { cache } from "react";
import { getLocationFromDb, type LocationDoc } from "@/lib/db";
import { seedLocationForSlug } from "@/lib/places";
import { TIMED_OUT, withTimeout } from "@/lib/with-timeout";

/**
 * Longest the page waits for the lookup of a shipped place before it renders
 * the seed. A slow or hung place store used to hold the page (or end in
 * "Location not found"): a shipped place needs no lookup at all.
 */
export const SEED_LOOKUP_TIMEOUT_MS = 2_500;
/** Any other slug may need the stored geography AND the Worker. */
export const LOOKUP_TIMEOUT_MS = 9_000;

/**
 * The location a slug names, for a page render. Never throws and never turns
 * a shipped place into "not found" (#414):
 *
 * - the lookup (`getLocationFromDb`) may answer, fail or hang; a hang is cut
 *   off after {@link SEED_LOOKUP_TIMEOUT_MS} for a shipped place;
 * - whatever happened, a slug the app ships renders from the static seed
 *   ("advertised means renderable"), as the comment on the resolver promises;
 * - any other slug that does not resolve is null (a real 404).
 */
export async function resolveLocationForPage(
  slug: string,
  resolve: (slug: string) => Promise<LocationDoc | null> = getLocationFromDb,
  timeouts: { seed: number; other: number } = {
    seed: SEED_LOOKUP_TIMEOUT_MS,
    other: LOOKUP_TIMEOUT_MS,
  },
): Promise<LocationDoc | null> {
  const seed = seedLocationForSlug(slug);
  let found: LocationDoc | null = null;
  try {
    const result = await withTimeout(
      Promise.resolve().then(() => resolve(slug)),
      seed ? timeouts.seed : timeouts.other,
    );
    if (result !== TIMED_OUT) found = result;
  } catch {
    // Fall through to the seed (or null).
  }
  if (found) return found;
  return seed
    ? ({ ...seed, updatedAt: seed.updatedAt ?? new Date() } as LocationDoc)
    : null;
}

/**
 * Per-request location resolver shared by the `[location]` layout, its
 * pages and their `generateMetadata`. React `cache()` dedupes by function
 * identity, so every caller must import THIS function for the layout's
 * lookup and the page's lookup to collapse into one DB round-trip.
 *
 * A resolver error degrades to the static seed for a shipped slug and to
 * `null` (not found) for any other (see {@link resolveLocationForPage}), so a
 * shipped slug still resolves during an outage (advertised = renderable).
 */
export const loadLocation = cache((slug: string) =>
  resolveLocationForPage(slug),
);
