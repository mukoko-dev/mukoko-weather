import { loadLocation } from "@/app/[location]/load-location";

/**
 * The location a `[location]` route's params name, or null when it does not
 * resolve. The caller decides what null means: pages call `notFound()`,
 * `generateMetadata` returns the not-found metadata. Shares the per-request
 * cache with the layout, so the lookup runs once per request.
 */
export async function resolveLocationParam(
  params: Promise<{ location: string }>,
) {
  const { location: slug } = await params;
  return loadLocation(slug);
}
