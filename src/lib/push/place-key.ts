/**
 * The coarse place key an alert subscription is allowed to carry
 * (data-infra ADR-0003 section 4, mukoko-dev/mukoko-weather#289).
 *
 * Alerts need a place; they do not need where a person is. The platform's
 * validator and the Nyuchi API accept only a catalogue slug (`harare`,
 * `nairobi-ke`) or `{name}--{geohash}` with exactly five geohash characters
 * (about 4.9 km square). The app's saved spots are seven characters (about
 * 153 m), so the client cuts them before it asks for alerts: cutting a
 * geohash is a prefix, and the five-character cell is the same place seen
 * from further away. Nothing finer than the cell ever leaves the browser for
 * this purpose.
 *
 * Pure: no storage, no network, no clock. Wiring it to the alerts panel is
 * step (e) of #289.
 */

import { parseSmartSlug } from "../smart-slug";

/** Geohash characters in a coarse place key (about 4.9 km square). */
export const ALERT_GEOHASH_LENGTH = 5;

/** The most places one person may ask alerts for (ADR-0003). */
export const MAX_ALERT_PLACES = 10;

/** The name half used when a spot's own name cannot be part of a valid key. */
const NEUTRAL_NAME = "place";

/**
 * The SAME expression the API (`PLACE_KEY_PATTERN` in
 * `nyuchi-api/gateway/lib/web_push.py`) and the generated validator for
 * `alertPreferences.placeSlugs` apply. It refuses: a finer or coarser spot
 * than five characters, a map feature ref (`--osm-w890123`), a coordinate
 * label (`12-35n-45-62e`), a platform slug ending in six hex digits
 * (`name-a1b2c3`), a trailing newline and anything over 80 characters. Keep
 * the three in step: a key this client built and the API refused would be a
 * silent failure to subscribe.
 */
export const PLACE_KEY_RE =
  /^(?!.*\n)(?=.{1,80}$)(?![0-9]+-[0-9]+[ns]-[0-9]+-[0-9]+[ew])(?!.*-[0-9a-f]{6}(--|$))[a-z0-9]+(-[a-z0-9]+)*(--[0-9b-hjkmnp-z]{5})?$/;

/** True when `key` is exactly what the API and the validator accept. */
export function isAlertPlaceKey(key: string): boolean {
  return typeof key === "string" && PLACE_KEY_RE.test(key);
}

/**
 * The coarse key for a location slug, or null when none can be made.
 *
 * - A catalogue slug (no `--`) is the key as it is, when it passes the
 *   grammar. The API still accepts it only if it resolves to a seed, city,
 *   town or village.
 * - A spot (`{name}--{geohash}`) is cut to a five-character geohash. A
 *   geohash shorter than five characters (about 39 km or more) is too coarse
 *   to be a forecast place and gives null.
 * - The name half is kept only when the whole key then passes the grammar;
 *   otherwise it becomes `place`. The API rebuilds the name from the place
 *   record and does not trust this one (ADR-0003), so the name is a label,
 *   never an identity.
 * - A map feature ref (`--osm-w890123`) gives null: it names one building and
 *   the slug carries no coordinate to cut. A caller that holds the place's
 *   coordinate can mint a spot slug from it instead.
 */
export function alertPlaceKey(slug: string): string | null {
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 80) {
    return null;
  }

  if (!slug.includes("--")) {
    return isAlertPlaceKey(slug) ? slug : null;
  }

  const parsed = parseSmartSlug(slug);
  if (!parsed || parsed.ref.kind !== "spot" || !parsed.geohash) return null;
  if (parsed.geohash.length < ALERT_GEOHASH_LENGTH) return null;

  const cell = parsed.geohash.slice(0, ALERT_GEOHASH_LENGTH);
  for (const name of [parsed.nameSlug, NEUTRAL_NAME]) {
    const key = `${name}--${cell}`;
    if (isAlertPlaceKey(key)) return key;
  }
  return null;
}

/**
 * The keys for a list of saved slugs, in order, without repeats and at most
 * {@link MAX_ALERT_PLACES}. Two spots in one 5 km cell are one place for
 * alert purposes, so the second is dropped.
 */
export function alertPlaceKeys(slugs: readonly string[]): string[] {
  const keys: string[] = [];
  const cells = new Set<string>();
  for (const slug of slugs) {
    const key = alertPlaceKey(slug);
    if (!key) continue;
    const cell = key.includes("--") ? key.slice(key.lastIndexOf("--")) : key;
    if (cells.has(cell)) continue;
    cells.add(cell);
    keys.push(key);
    if (keys.length === MAX_ALERT_PLACES) break;
  }
  return keys;
}
