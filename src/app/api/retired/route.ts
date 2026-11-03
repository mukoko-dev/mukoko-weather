/**
 * The retired Python API: every `/api/py/*` path answers a 404 problem
 * document, whatever the method.
 *
 * The FastAPI backend that served `/api/py/*` was deleted (#333); every route
 * is a Rust Worker route at `https://weather-api.mukoko.com/v1/...`. Without
 * this an unmatched `/api/py/...` URL fell to the root not-found page (HTML,
 * "Location not found"), a confusing answer for a program. `next.config.ts`
 * rewrites `/api/py/*` here (RETIRED_API_SOURCE in `src/lib/retired-api.ts`).
 *
 * The one `/api/py` path that still works, the weather-station upload URL
 * `/api/py/stations/ingest`, is NOT matched by that rewrite and no route file
 * of this app covers it, so nothing in Next.js can ever answer it: on Vercel
 * `vercel.json` rewrites it to the stations Worker, and under a plain `next
 * start` (no rewrite) it falls to the root 404 like any unknown URL.
 *
 * Not `force-static`: Next.js cannot statically generate a route that exports
 * POST, PUT, PATCH or DELETE, and answered 500 for every request when this
 * handler said so (found by running the built app).
 */
const DETAIL =
  "The Python API under /api/py was removed. The weather API is at https://weather-api.mukoko.com/v1/ (see https://weather.mukoko.com/developers).";

function retired(cacheable: boolean): Response {
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
        // Only a read is worth keeping: a write never is.
        "Cache-Control": cacheable ? "public, max-age=300" : "no-store",
      },
    },
  );
}

export const GET = () => retired(true);
export const HEAD = () => retired(true);
export const POST = () => retired(false);
export const PUT = () => retired(false);
export const PATCH = () => retired(false);
export const DELETE = () => retired(false);
export const OPTIONS = () => retired(false);
