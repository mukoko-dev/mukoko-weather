/**
 * Plain 404 for a missing top-level file.
 *
 * `next.config.ts` rewrites every single-segment dotted path that isn't a real
 * public file or static route (for example a deleted `/favicon-48.png`) here,
 * so it returns a real 404 instead of the `[location]` page's streamed
 * "Location not found", which goes out with HTTP 200.
 */
export const dynamic = "force-static";

export function GET(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

export const HEAD = GET;
