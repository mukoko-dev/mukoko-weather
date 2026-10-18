import { loadReleaseNotes } from "@/lib/release-notes-source";
import { buildReleasesAtomFeed } from "@/lib/release-notes";
import { SITE_URL } from "@/lib/site";

// Generated at build time from releases/ — never on the request path.
export const dynamic = "force-static";

/** GET /releases/feed.xml — Atom 1.0 feed of the public release notes. */
export function GET() {
  return new Response(buildReleasesAtomFeed(loadReleaseNotes(), SITE_URL), {
    headers: {
      "Content-Type": "application/atom+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
