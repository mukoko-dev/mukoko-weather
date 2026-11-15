import type { APIRoute } from "astro";
import { buildReleasesAtomFeed } from "@/lib/release-notes";
import { SITE_URL } from "@/lib/site";
import { releases } from "~/lib/releases";

/**
 * GET /releases/feed.xml: the Atom 1.0 feed of the release notes, written when
 * the site is built (never on a request). The headers the Next.js route set
 * (`Cache-Control: public, max-age=3600, s-maxage=86400`, and the Atom content
 * type) belong to whatever serves the file, as static assets have no headers
 * of their own here: see astro/README.md, "Route parity".
 */
export const prerender = true;

export const GET: APIRoute = () =>
  new Response(buildReleasesAtomFeed(releases(), SITE_URL), {
    headers: { "Content-Type": "application/atom+xml; charset=utf-8" },
  });
