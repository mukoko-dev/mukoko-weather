import { notFound } from "next/navigation";
import { loadLocation } from "./load-location";

/**
 * Backstop: resolve the slug BEFORE any Suspense boundary under this segment.
 *
 * The proxy's location gate (src/lib/location-gate.ts, #263) already rewrites
 * unknown slugs to a server-rendered 404, so this only fires when the proxy
 * let a slug through after a failed lookup. `[location]/loading.tsx` wraps
 * the page in Suspense, so a `notFound()` thrown from the page would arrive
 * after the 200 shell has been flushed (the soft 404 from #237). Thrown here
 * it still yields a real 404, although Next 16 then serves an empty shell
 * that renders after hydration — hence the proxy gate in front of it.
 */
export default async function LocationLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ location: string }>;
}) {
  const { location: slug } = await params;
  if (!(await loadLocation(slug))) notFound();
  return children;
}
