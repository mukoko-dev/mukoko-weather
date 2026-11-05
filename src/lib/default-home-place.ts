import { DEFAULT_HOME_SLUG } from "./default-places";
import { LOCATIONS, type WeatherLocation } from "./locations";
import { canonicalSlug } from "./slug-migration";

/**
 * Harare, from the shipped seed: it needs no database and no network lookup,
 * so the home page can always seed it (#414).
 *
 * Kept apart from `default-home.ts` (which also holds a loader that fetches a
 * forecast) so the server render of `/` can import it without importing any
 * weather loader: `src/app/place-pages-no-weather.test.ts` pins that.
 */
export function defaultHomeLocation(): WeatherLocation {
  const seed = LOCATIONS.find((l) => l.slug === DEFAULT_HOME_SLUG);
  if (!seed) {
    // Pinned by a test; a catalogue without Harare is a build error, not a
    // runtime case.
    throw new Error(`Seed place ${DEFAULT_HOME_SLUG} is missing`);
  }
  // The seed list keys on the legacy slug; the page carries the canonical one.
  return { ...seed, slug: canonicalSlug(seed.slug) };
}
