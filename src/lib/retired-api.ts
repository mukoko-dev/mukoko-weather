/**
 * The rewrite in `next.config.ts` that sends every retired `/api/py/*` path to
 * `src/app/api/retired/route.ts` (a 404 problem document).
 *
 * The weather-station upload URL `/api/py/stations/ingest` is excluded by a
 * negative lookahead, so that no rule or route of this app can ever match it:
 * `vercel.json` rewrites it to the stations Worker, and the rewrite there must
 * not have to win a race against anything here.
 */
export const RETIRED_API_SOURCE = "/api/py/:path((?!stations/ingest$).*)";
/** `/api/py` itself, with nothing after it. */
export const RETIRED_API_ROOT = "/api/py";
export const RETIRED_API_DESTINATION = "/api/retired";

/** The same pattern as an anchored RegExp, for the tests. */
export const RETIRED_API_RE = /^\/api\/py\/((?!stations\/ingest$).*)$/;
