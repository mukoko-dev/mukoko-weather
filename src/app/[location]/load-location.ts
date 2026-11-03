import { cache } from "react";
import { getLocationFromDb, type LocationDoc } from "@/lib/db";
import { localPlaceForSlug } from "@/lib/local-place";
import { TIMED_OUT, withTimeout } from "@/lib/with-timeout";

/**
 * Longest a page waits for the stored geography to name a slug the app does
 * not ship: it may need the database AND the Worker.
 */
export const LOOKUP_TIMEOUT_MS = 9_000;

/**
 * The location a slug names, for a page render. Never throws and never turns
 * a shipped place into "not found" (#414):
 *
 * - a shipped place or a spot is answered with NO lookup (issue #452: a page
 *   does not wait on data for a place it can name from the seed or from the
 *   slug itself; the browser corrects the region and height from the
 *   forecast);
 * - any other slug asks the stored geography (`getLocationFromDb`), which may
 *   answer, fail or hang; a hang is cut off after `timeoutMs`;
 * - a slug that does not resolve is null.
 */
export async function resolveLocationForPage(
  slug: string,
  resolve: (slug: string) => Promise<LocationDoc | null> = getLocationFromDb,
  timeoutMs: number = LOOKUP_TIMEOUT_MS,
): Promise<LocationDoc | null> {
  const local = localPlaceForSlug(slug);
  if (local) return { ...local, updatedAt: new Date() } as LocationDoc;
  try {
    const result = await withTimeout(
      Promise.resolve().then(() => resolve(slug)),
      timeoutMs,
    );
    return result === TIMED_OUT ? null : result;
  } catch {
    return null;
  }
}

/**
 * Per-request location resolver shared by the `[location]` sub-routes and the
 * `generateMetadata` of the place page. React `cache()` dedupes by function
 * identity, so every caller must import THIS function for the lookups of one
 * request to collapse into one DB round-trip.
 *
 * A resolver error degrades to `null` (not found) for a slug that needs a
 * lookup; a shipped place or a spot never needs one (see
 * {@link resolveLocationForPage}).
 */
export const loadLocation = cache((slug: string) =>
  resolveLocationForPage(slug),
);
