/**
 * Canonical slugs: every place is `{name}--{ref}`.
 *
 * Until now ~265 shipped seed places lived under legacy slugs (`harare`,
 * `nairobi-ke`), community places under `{name}-{cc}` or a platform slug
 * (`harare-a1b2c3`), and everything else under the smart-slug grammar
 * (`{name}--{geohash7}`, `{name}--osm-{ref}`). Owner decision: move ALL of
 * them to the smart-slug model. This module is the one place that knows the
 * mapping; it is pure and light (no database, no `LOCATIONS`), so the edge
 * proxy, the stores and the resolvers all import it.
 *
 * - Every legacy seed slug has ONE canonical slug, pinned in
 *   `slug-migration-data.ts` (derived once from the seed's name and
 *   coordinate; see docs/canonical-slugs.md). The map is a bijection and
 *   canonical slugs are never legacy slugs, so redirects cannot loop.
 * - A legacy slug redirects (308) to its canonical slug forever; nothing
 *   that was ever linked 404s.
 * - Durable data (history, reports, AI caches) stays under the LEGACY key:
 *   {@link storageKeySlug} maps a canonical seed slug back, so a place's
 *   history is never split or lost by the move.
 * - Platform and community slugs cannot be tabulated (their ids live in the
 *   database), so they are normalised by the resolver, see
 *   `canonicalSlugForPlace` in `places.ts`.
 */
import { SEED_SLUG_TABLE } from "./slug-migration-data";
import { SMART_SLUG_DELIMITER } from "./smart-slug";

/** Legacy seed slug → canonical slug. */
export const LEGACY_TO_CANONICAL: ReadonlyMap<string, string> = new Map(
  SEED_SLUG_TABLE,
);

/** Canonical seed slug → legacy slug (the durable-data key). */
export const CANONICAL_TO_LEGACY: ReadonlyMap<string, string> = new Map(
  SEED_SLUG_TABLE.map(([legacy, canonical]) => [canonical, legacy]),
);

/** True for a shipped seed place's legacy slug (`harare`, `nairobi-ke`). */
export function isLegacySeedSlug(slug: string): boolean {
  return LEGACY_TO_CANONICAL.has(slug);
}

/** True for the canonical slug of a shipped seed place (`harare--ksy4dd1`). */
export function isCanonicalSeedSlug(slug: string): boolean {
  return CANONICAL_TO_LEGACY.has(slug);
}

/**
 * The canonical slug for `slug`: a legacy seed slug is mapped, anything else
 * (already canonical, a spot, an OSM place, a platform slug, junk) comes back
 * unchanged. Idempotent: `canonicalSlug(canonicalSlug(x)) === canonicalSlug(x)`.
 */
export function canonicalSlug(slug: string): string {
  return LEGACY_TO_CANONICAL.get(slug) ?? slug;
}

/**
 * The key durable data is stored under. A canonical seed slug maps back to
 * its legacy slug, so history, reports and AI caches written before the move
 * are still found; any other slug is its own key (a spot's `geo:<hash>` key
 * is the backend's job, see `storage_slug`). Idempotent.
 */
export function storageKeySlug(slug: string): string {
  return CANONICAL_TO_LEGACY.get(slug) ?? slug;
}

/**
 * Map a list of slugs to canonical form, dropping duplicates (a device that
 * saved both `harare` and `harare--ksy4dd1`) and keeping first-seen order.
 */
export function canonicalSlugList(slugs: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const slug of slugs) {
    const next = canonicalSlug(slug);
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
  }
  return out;
}

/** Re-key an object whose keys are slugs (`locationLabels`) to canonical. */
export function canonicalSlugRecord<T>(
  record: Readonly<Record<string, T>>,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    const next = canonicalSlug(key);
    // A canonical key already present wins over a legacy duplicate.
    if (!(next in out) || next === key) out[next] = value;
  }
  return out;
}

/** The slug-bearing fields of the persisted preferences. */
export interface SlugPrefs {
  selectedLocation?: string;
  savedLocations?: string[];
  homeLocation?: string | null;
  hiddenPresetSlugs?: string[];
  locationLabels?: Record<string, string>;
}

/**
 * Migrate the slug fields of a preferences object to canonical slugs. Pure
 * and idempotent: a second pass returns an equal object, so the callers
 * (RxDB hydrate, device-sync pull, legacy localStorage import) can run it
 * every time and write back only when {@link slugPrefsChanged}.
 */
export function migrateSlugPrefs<T extends SlugPrefs>(prefs: T): T {
  const next: T = { ...prefs };
  if (typeof prefs.selectedLocation === "string") {
    next.selectedLocation = canonicalSlug(prefs.selectedLocation);
  }
  if (Array.isArray(prefs.savedLocations)) {
    next.savedLocations = canonicalSlugList(prefs.savedLocations);
  }
  if (typeof prefs.homeLocation === "string") {
    next.homeLocation = canonicalSlug(prefs.homeLocation);
  }
  if (Array.isArray(prefs.hiddenPresetSlugs)) {
    next.hiddenPresetSlugs = canonicalSlugList(prefs.hiddenPresetSlugs);
  }
  if (prefs.locationLabels && typeof prefs.locationLabels === "object") {
    next.locationLabels = canonicalSlugRecord(prefs.locationLabels);
  }
  return next;
}

/** True when {@link migrateSlugPrefs} would change any slug field. */
export function slugPrefsChanged(before: SlugPrefs, after: SlugPrefs): boolean {
  return JSON.stringify(slugView(before)) !== JSON.stringify(slugView(after));
}

function slugView(p: SlugPrefs) {
  return [
    p.selectedLocation ?? null,
    p.savedLocations ?? null,
    p.homeLocation ?? null,
    p.hiddenPresetSlugs ?? null,
    p.locationLabels ? Object.keys(p.locationLabels).sort() : null,
  ];
}

/**
 * `/{slug}` or `/{slug}/{sub}` for a place, always canonical. `sub` is one of
 * the location sub-routes (`forecast`, `atmosphere`, `map`, `agriculture`).
 */
export function locationPath(slug: string, sub?: string): string {
  const base = `/${canonicalSlug(slug)}`;
  return sub ? `${base}/${sub}` : base;
}

/** True when `slug` already has the `{name}--{ref}` shape. */
export function hasSmartDelimiter(slug: string): boolean {
  return slug.includes(SMART_SLUG_DELIMITER);
}
