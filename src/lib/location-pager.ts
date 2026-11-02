import { isLocationSlug } from "@/lib/current-slug";

/**
 * Pure helpers for paging between the visitor's locations.
 *
 * The pager sequence is the ordered list of pages the bottom bar's places lane
 * and the swipe gesture walk through, in the same order as the Locations list:
 * index 0 is the home page (`/`, always "My Location"), then one page per
 * saved location, then one page per visible suggested place (see
 * location-presets.ts). Nothing here reads the DOM or the store.
 */

/** Href of the "My Location" page (index 0 of every sequence). */
export const MY_LOCATION_HREF = "/";

/**
 * Most place chips the lane renders besides My Location. Saved places (capped
 * at 10) plus the suggested places (at most 6) fit; the lane scrolls sideways
 * for overflow.
 */
export const MAX_PAGER_DOTS = 24;

/**
 * Ordered page hrefs: `["/", "/savedA", "/savedB", "/presetA", …]`.
 *
 * Duplicates and anything that is not a real location slug (`isLocationSlug`
 * rejects route names such as `explore`) are dropped, so a stale or tampered
 * persisted list can never produce a broken or unintended page.
 */
export function pagerSequence(
  savedLocations: readonly unknown[] | null | undefined,
  presets: readonly unknown[] | null | undefined = [],
): string[] {
  const sequence = [MY_LOCATION_HREF];
  const seen = new Set<string>();
  for (const slug of [...(savedLocations ?? []), ...(presets ?? [])]) {
    if (!isLocationSlug(slug) || seen.has(slug)) continue;
    seen.add(slug);
    sequence.push(`/${slug}`);
  }
  return sequence;
}

/**
 * Index in `sequence` of the page the pathname belongs to, or -1 when the
 * pathname is not one of the pager's pages (e.g. `/explore`, or a location
 * that is not in the sequence). Sub-routes count as their location:
 * `/harare/map` is the `/harare` page.
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
 * The place hrefs shown after the "My Location" chip, capped at
 * `MAX_PAGER_DOTS`. The home page is excluded: it is the lane's pinned first
 * chip.
 */
export function pagerDots(sequence: readonly string[]): string[] {
  return sequence.slice(1, MAX_PAGER_DOTS + 1);
}

/** One chip in the bottom bar's places lane. */
export interface LaneChip {
  href: string;
  /** "home" is My Location (`/`); every other chip is a place. */
  kind: "home" | "place";
  /** The place slug, null for My Location. */
  slug: string | null;
}

/**
 * The chips of the places lane, in order. My Location is ALWAYS first (current
 * location comes before every saved place, owner rule), whatever the sequence
 * holds, and the lane is never empty. The rest are `pagerDots(sequence)`.
 */
export function laneChips(sequence: readonly string[]): LaneChip[] {
  return [
    { href: MY_LOCATION_HREF, kind: "home", slug: null },
    ...pagerDots(sequence).map((href): LaneChip => ({
      href,
      kind: "place",
      slug: href.slice(1),
    })),
  ];
}

/**
 * Index of the lane chip that is the current page: the chip for the pager page
 * `pagerIndex` found (the sequence and the chips line up one to one up to the
 * cap), or -1 when no chip is current (e.g. `/explore`, `/locations`, or a
 * place past the cap).
 */
export function laneActiveIndex(
  pathname: string | null | undefined,
  sequence: readonly string[],
  chipCount: number,
): number {
  const index = pagerIndex(pathname, sequence);
  return index >= 0 && index < chipCount ? index : -1;
}

/**
 * Whether the pinned My Location chip spells its name out. Only when it is
 * the lane's single chip: with places beside it the chip is the glyph alone
 * (its accessible name stays "My Location"), which keeps its width constant
 * and leaves the lane to the places.
 */
export function homeChipShowsLabel(chipCount: number): boolean {
  return chipCount <= 1;
}

/** Measurements `laneScrollLeft` needs, all in CSS pixels. */
export interface LaneMeasure {
  /** Visible width of the scroller. */
  viewport: number;
  /** Full scrollable width. */
  content: number;
  /** The active chip's left edge in content coordinates. */
  itemLeft: number;
  itemWidth: number;
}

/**
 * Where to scroll the lane's places so the active chip is centred, clamped to
 * the scrollable range. My Location (index 0) is pinned outside the scroller,
 * so it never needs scrolling to: the lane goes back to its start. A chip
 * near either end stays where the clamp puts it.
 */
export function laneScrollLeft(m: LaneMeasure, activeIndex: number): number {
  if (activeIndex <= 0) return 0;
  const raw = m.itemLeft + m.itemWidth / 2 - m.viewport / 2;
  const max = Math.max(0, m.content - m.viewport);
  return Math.min(Math.max(raw, 0), max);
}
