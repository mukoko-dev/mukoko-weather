/**
 * The pages that have a card of their own, as data: the path, and the title
 * and description the page itself sends (`og.test.ts` reads each page file and
 * fails when they differ, so a card never says something the page does not).
 * A page that is not here shares the site card; it never points at a file that
 * does not exist.
 */
import { SITE_URL } from "@/lib/site";

export const SITE_CARD_SLUG = "site";

export interface PageCard {
  /** Canonical path, as the page's `canonicalPath`. */
  path: string;
  /** The page's own title (the `<title>` adds the site name). */
  title: string;
  description: string;
  /** The page's file under src/pages, for the drift test. */
  file: string;
}

export const PAGE_CARDS: readonly PageCard[] = [
  {
    path: "/about",
    title: "About",
    description:
      "Learn about mukoko weather — a global weather intelligence platform providing forecasts for farming, mining, travel, and daily life worldwide. A Mukoko Africa product by Nyuchi Web Services.",
    file: "about.astro",
  },
  {
    path: "/help",
    title: "Help & FAQ",
    description:
      "Get help with mukoko weather — how to use forecasts, understand frost alerts, install the app, and more. Frequently asked questions about our weather intelligence platform.",
    file: "help.astro",
  },
  {
    path: "/privacy",
    title: "Privacy Policy",
    description:
      "Privacy Policy for mukoko weather. Learn how we handle your data — spoiler: we collect almost nothing.",
    file: "privacy.astro",
  },
  {
    path: "/releases",
    title: "Release notes",
    description:
      "What's new in mukoko weather: new features, improvements and fixes in each release, in plain language.",
    file: "releases.astro",
  },
  {
    path: "/status",
    title: "System Status",
    description:
      "Live health checks for mukoko weather services — weather APIs, AI summaries, database, and caching status.",
    file: "status.astro",
  },
  {
    path: "/terms",
    title: "Terms of Service",
    description:
      "Terms of Service for mukoko weather — a weather intelligence platform, operated by Mukoko Africa, a division of Nyuchi Africa (PVT) Ltd.",
    file: "terms.astro",
  },
];

/** Where a card's PNG is served, from its slug. */
export const ogPath = (slug: string) => `/og/${slug}.png`;

export const pageSlug = (path: string) => `pages/${path.replace(/^\//, "")}`;
export const locationSlug = (slug: string) => `locations/${slug}`;

/** Path of the card for a page: its own when it has one, else the site card. */
export function ogPathFor(canonicalPath?: string): string {
  const own = PAGE_CARDS.find((p) => p.path === canonicalPath);
  return ogPath(own ? pageSlug(own.path) : SITE_CARD_SLUG);
}

/** The absolute URL scrapers get: never relative. */
export const ogUrlFor = (canonicalPath?: string) =>
  `${SITE_URL}${ogPathFor(canonicalPath)}`;
