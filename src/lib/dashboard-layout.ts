/**
 * Location-page layout rhythm — the class strings both dashboard columns use,
 * and the grid-fill helper for the Conditions tiles.
 *
 * One spacing scale, defined as tokens in globals.css:
 *   --space-section  gap between sections, and between the two columns
 *   --space-stack    heading-to-card and card-to-card inside a section
 *   --space-card     padding inside every card (.baobab / .acacia / .pangolin)
 *
 * Literal class names only (Tailwind needs to see them at build time).
 */

/**
 * Vertical stack of page sections, one --space-section apart (the .herd
 * fauna class, which also drops lazy wrappers whose card rendered nothing).
 */
export const SECTION_STACK_CLASS = "herd";

/** Main column: 2 of 3 columns on lg, 3 of 4 on xl. */
export const MAIN_COLUMN_CLASS = `${SECTION_STACK_CLASS} lg:col-span-2 xl:col-span-3`;

/** Sidebar: 1 column on lg and xl. */
export const SIDEBAR_COLUMN_CLASS = `${SECTION_STACK_CLASS} lg:col-span-1 xl:col-span-1`;

/**
 * How many columns the LAST tile of a run of `count` tiles must span so the
 * final row of a `cols`-column grid is filled instead of leaving empty slots.
 * Returns 1 when the run already fills its last row (or is empty).
 */
export function fillLastRowSpan(count: number, cols: number): number {
  if (!Number.isFinite(count) || !Number.isFinite(cols)) return 1;
  const n = Math.floor(count);
  const c = Math.floor(cols);
  if (n <= 0 || c <= 1) return 1;
  const remainder = n % c;
  return remainder === 0 ? 1 : c - remainder + 1;
}

/** Span → class for the 2-column (mobile) Conditions grid. */
const BASE_SPAN_CLASS: Record<number, string> = {
  1: "",
  2: "col-span-2 [&>section]:aspect-auto",
};

/** Span → class for the 4-column (lg) Conditions grid. */
const LG_SPAN_CLASS: Record<number, string> = {
  1: "lg:col-span-1 lg:[&>section]:aspect-square",
  2: "lg:col-span-2 lg:[&>section]:aspect-auto",
  3: "lg:col-span-3 lg:[&>section]:aspect-auto",
  4: "lg:col-span-4 lg:[&>section]:aspect-auto",
};

/**
 * Classes for the last tile of a run of `count` square tiles in the
 * Conditions grid (2 columns on mobile, 4 on lg), so neither layout ends
 * with an empty slot. A spanned tile drops its square aspect so it keeps
 * the row's natural height instead of doubling it.
 */
export function lastTileSpanClass(count: number): string {
  const base = BASE_SPAN_CLASS[fillLastRowSpan(count, 2)] ?? "";
  const lgSpan = fillLastRowSpan(count, 4);
  // Only emit lg classes when the lg layout needs something different from
  // the base: a base-spanned tile that fits one lg cell must be reset.
  const lg = lgSpan > 1 || base ? (LG_SPAN_CLASS[lgSpan] ?? "") : "";
  return [base, lg].filter(Boolean).join(" ");
}
