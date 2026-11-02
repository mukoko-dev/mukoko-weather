/**
 * The places a visitor gets before anything is known about them (#414).
 *
 * The home page shows Harare, never a page for choosing cities, and the pager
 * in the bottom bar offers Harare, Nairobi and Lagos until the visitor saves
 * places of their own. All three are shipped seed places, so they render
 * without a lookup. Search and browse stay one tap away in My Weather and on
 * the Locations list.
 *
 * Constants only (no imports), so the pager and the home page can both read
 * them without pulling in each other.
 */

/** What `/` shows with no `lastLocation` cookie and no usable IP position. */
export const DEFAULT_HOME_SLUG = "harare";

/** The default pager and Locations suggestions, in order. */
export const DEFAULT_PAGER_SLUGS: readonly string[] = [
  "harare",
  "nairobi-ke",
  "lagos-ng",
];
