/**
 * The retired Python API: every `/api/py/*` path answers a plain 404.
 *
 * The FastAPI backend that served `/api/py/*` was deleted (#333); every route
 * is a Rust Worker route at `https://weather-api.mukoko.com/v1/...`. Without
 * this handler an unmatched `/api/py/...` URL fell to the root not-found page
 * (HTML, "Location not found"), which is a confusing answer for a program. A
 * 404 problem document (RFC 9457) names where the API went instead.
 *
 * The one `/api/py` path that still works is the weather-station upload URL
 * `/api/py/stations/ingest`: `vercel.json` rewrites it to the stations Worker
 * before Next.js routes the request, so it never reaches this handler on
 * Vercel (under a plain `next start` there is no rewrite and it answers 404
 * here, like any other).
 *
 * Not `force-static`: Next.js cannot statically generate a route that exports
 * POST, PUT, PATCH or DELETE, and answered 500 for every request when this
 * handler said so (found by running the built app).
 */
const DETAIL =
  "The Python API under /api/py was removed. The weather API is at https://weather-api.mukoko.com/v1/ (see https://weather.mukoko.com/developers).";

function gone(): Response {
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: DETAIL,
    }),
    {
      status: 404,
      headers: {
        "Content-Type": "application/problem+json",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}

export const GET = gone;
export const HEAD = gone;
export const POST = gone;
export const PUT = gone;
export const PATCH = gone;
export const DELETE = gone;
export const OPTIONS = gone;
