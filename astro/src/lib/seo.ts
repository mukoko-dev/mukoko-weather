/**
 * The site-wide head metadata, as data: the values the Next.js root layout
 * (src/app/layout.tsx) puts in `metadata`. `seo.test.ts` reads the layout and
 * fails when the two disagree, so a change to one is a change to both.
 */
import { ogUrlFor } from "~/lib/og/pages";

export const DEFAULT_TITLE = "mukoko weather — Global Weather Intelligence";

export const TWITTER_DESCRIPTION =
  "Global weather intelligence. Forecasts for farming, mining, travel, and daily life across 265+ locations worldwide.";

export const KEYWORDS = [
  "global weather",
  "weather forecast",
  "weather intelligence",
  "AI weather",
  "farming weather",
  "frost alerts",
  "weather Africa",
  "Zimbabwe weather",
  "Harare weather",
  "frost alert Zimbabwe",
  "weather Asia",
  "weather developing world",
  "mukoko",
  "mukoko weather",
  "Nyuchi Africa",
];

/**
 * The card image every page without its own shares: the site card, drawn at
 * build time (src/lib/og). The Next.js layout still points at its `/api/og`
 * route; the Astro head does not repeat that URL, it has its own cards.
 */
export const OG_IMAGE_URL = ogUrlFor();

export const OG_IMAGE = {
  width: 1200,
  height: 630,
  type: "image/png",
  alt: DEFAULT_TITLE,
} as const;

export const ROBOTS =
  "index, follow, max-video-preview:-1, max-image-preview:large, max-snippet:-1";

/** `<title>` for a page: the layout's `%s | mukoko weather` template. */
export function pageTitle(title: string): string {
  return title.includes("mukoko") ? title : `${title} | mukoko weather`;
}
