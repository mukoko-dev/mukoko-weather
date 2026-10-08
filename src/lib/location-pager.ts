import { isLocationSlug } from "@/lib/current-slug";

/**
 * Pure helpers for paging between the visitor's locations.
 *
 * The pager sequence is the ordered list of pages the bottom bar's dots and
 * the swipe gesture walk through: index 0 is the home page (`/`, which is
 * always "My Location"), followed by one page per saved location. Nothing here
 * reads the DOM or the store — callers pass the saved slugs and pathname in.
 */

/** Href of the "My Location" page (index 0 of every sequence). */
export const MY_LOCATION_HREF = "/";

/** Most dots the page indicator renders (the saved-location cap is 10 too). */
export const MAX_PAGER_DOTS = 10;

/**
 * Ordered page hrefs: `["/", "/slugA", "/slugB", …]`.
 *
 * Duplicates and anything that is not a real location slug (`isLocationSlug`
 * rejects route names such as `explore`) are dropped, so a stale or tampered
 * persisted list can never produce a broken or unintended page.
 */
export function pagerSequence(
  savedLocations: readonly unknown[] | null | undefined,
): string[] {
  const sequence = [MY_LOCATION_HREF];
  const seen = new Set<string>();
  for (const slug of savedLocations ?? []) {
    if (!isLocationSlug(slug) || seen.has(slug)) continue;
    seen.add(slug);
    sequence.push(`/${slug}`);
  }
  return sequence;
}

/**
 * Index in `sequence` of the page the pathname belongs to, or -1 when the
 * pathname is not one of the pager's pages (e.g. `/explore`, or a location
 * that is not saved). Sub-routes count as their location: `/harare/map` is the
 * `/harare` page.
 */
export function pagerIndex(
  pathname: string | null | undefined,
  sequence: readonly string[],
): number {
  const firstSegment = (pathname ?? "")
    .split("/")
    .find((segment) => segment.length > 0);
  const target =
    firstSegment === undefined ? MY_LOCATION_HREF : `/${firstSegment}`;
  return sequence.indexOf(target);
}

/**
 * The page one step away from `index` (`dir` 1 = next, -1 = previous), or
 * null at either end, when `index` is not a pager page (-1), or when the
 * sequence has no such step. Never wraps: swiping past the last location stops.
 */
export function neighbour(
  sequence: readonly string[],
  index: number,
  dir: 1 | -1,
): string | null {
  if (index < 0 || index >= sequence.length) return null;
  const next = index + dir;
  if (next < 0 || next >= sequence.length) return null;
  return sequence[next];
}

/**
 * The saved-location dots shown beside the "My Location" glyph, capped at
 * `MAX_PAGER_DOTS`. The home page is excluded — it has its own glyph.
 */
export function pagerDots(sequence: readonly string[]): string[] {
  return sequence.slice(1, MAX_PAGER_DOTS + 1);
}
