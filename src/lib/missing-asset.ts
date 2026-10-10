/**
 * The single source of the missing-file rewrite in `next.config.ts`.
 *
 * Any top-level path segment containing a dot is a file request, never a
 * location: slugs match `^[a-z0-9-]{1,80}$`. An `afterFiles` rewrite runs
 * after public files and static routes (`robots.txt`, `sitemap.xml`,
 * `manifest.json` and so on) are matched, so this only catches a file that
 * doesn't exist. It goes to the plain 404 handler instead of falling through
 * to `[location]`, which would stream "Location not found" with HTTP 200.
 */
const SEGMENT = "[^/]*\\.[^/]*";

/** path-to-regexp source for the `afterFiles` rewrite. */
export const MISSING_ASSET_SOURCE = `/:file(${SEGMENT})`;
export const MISSING_ASSET_DESTINATION = "/api/missing-asset";

/** The same pattern as an anchored RegExp, built from the one segment. */
export const MISSING_ASSET_RE = new RegExp(`^/(${SEGMENT})$`);
