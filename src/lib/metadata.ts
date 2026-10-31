/**
 * Page metadata for the location pages. One builder so every `[location]`
 * route emits the same canonical, Open Graph and Twitter shape, and the
 * "Location not found" fallback lives in one place.
 *
 * Canonical and `og:url` are `SITE_URL` + `path`. The root layout sets no
 * canonical (see src/app/seo.test.ts), so every page must set its own.
 */
import type { Metadata } from "next";
import { SITE_URL } from "@/lib/site";

export const LOCATION_NOT_FOUND_TITLE = "Location not found";
const SITE_NAME = "mukoko weather";

export interface PageOgImage {
  url: string;
  width: number;
  height: number;
  alt: string;
}

export interface PageMetadata {
  /** Document `<title>`. */
  title: string;
  description: string;
  /** Path under SITE_URL, e.g. `/harare/forecast`. */
  path: string;
  keywords: string[];
  /** Open Graph title/description; the image is optional. */
  og: { title: string; description: string; image?: PageOgImage };
  /** Present only on pages that carry a Twitter card. */
  twitter?: { title: string; description: string; images?: string[] };
}

export type PageMetadataInput = PageMetadata | { notFound: true };

/**
 * Next metadata for a location page. `{ notFound: true }` gives the shared
 * "Location not found" title used when the slug does not resolve.
 */
export function buildPageMetadata(input: PageMetadataInput): Metadata {
  if ("notFound" in input) return { title: LOCATION_NOT_FOUND_TITLE };

  const url = `${SITE_URL}${input.path}`;
  return {
    title: input.title,
    description: input.description,
    keywords: input.keywords,
    alternates: { canonical: url },
    openGraph: {
      title: input.og.title,
      description: input.og.description,
      url,
      type: "website",
      locale: "en",
      siteName: SITE_NAME,
      ...(input.og.image ? { images: [input.og.image] } : {}),
    },
    ...(input.twitter
      ? {
          twitter: {
            card: "summary_large_image",
            title: input.twitter.title,
            description: input.twitter.description,
            ...(input.twitter.images ? { images: input.twitter.images } : {}),
          },
        }
      : {}),
  };
}
