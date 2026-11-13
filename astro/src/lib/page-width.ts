/**
 * The main column of an ordinary page: the same recipe as the Next.js
 * `PageShell` (src/components/layout/PageShell.tsx), which `page-width.test.ts`
 * checks so the two cannot drift. Width names are Mzizi's `mzizi-page` (N6).
 */
export const WIDTH_CLASS = {
  feed: "max-w-2xl",
  settings: "max-w-2xl",
  prose: "max-w-3xl",
  detail: "max-w-4xl",
  wide: "max-w-5xl",
  dashboard: "max-w-7xl",
} as const;

export const MAIN_CLASS =
  "mx-auto w-full px-4 py-8 pb-[var(--mobile-nav-clearance)] sm:px-6 sm:pb-8 md:px-8";

export type PageWidth = keyof typeof WIDTH_CLASS;
