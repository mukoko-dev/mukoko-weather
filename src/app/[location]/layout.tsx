import { notFound } from "next/navigation";
import { loadLocation } from "./load-location";

/**
 * Resolve the slug BEFORE any Suspense boundary under this segment.
 *
 * `[location]/loading.tsx` wraps the page in Suspense, so a `notFound()`
 * thrown from the page arrives after the 200 shell has been flushed: the
 * visitor sees "Location not found" but crawlers see a soft 404 (#237).
 * Calling `notFound()` here, in the segment layout, runs before that
 * boundary, so Next.js can still send a real 404 status.
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
