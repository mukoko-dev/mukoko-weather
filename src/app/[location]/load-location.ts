import { cache } from "react";
import { getLocationFromDb } from "@/lib/db";

/**
 * Per-request location resolver shared by the `[location]` layout, its
 * pages and their `generateMetadata`. React `cache()` dedupes by function
 * identity, so every caller must import THIS function for the layout's
 * lookup and the page's lookup to collapse into one DB round-trip.
 *
 * A resolver error degrades to `null` (not found) rather than throwing.
 * The resolver already falls back to the static seed on DB errors, so a
 * shipped slug still resolves during an outage (advertised = renderable).
 */
export const loadLocation = cache((slug: string) =>
  getLocationFromDb(slug).catch(() => null),
);
