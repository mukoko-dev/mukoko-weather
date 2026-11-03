import { isLocationSlug } from "@/lib/current-slug";

/**
 * What a URL asks the place stage to show.
 *
 * Only two shapes are places: `/` (My Location, the silent-URL home) and
 * `/{slug}` exactly. A sub-route (`/harare/forecast`), another route
 * (`/explore`), a path with a query or a hash, or anything that is not a
 * same-origin path is a normal navigation: the router handles it.
 */
export type PlaceTarget = { kind: "home" } | { kind: "slug"; slug: string };

/** The place a href or pathname names, or null when it is not one. */
export function placeTargetOf(
  href: string | null | undefined,
): PlaceTarget | null {
  if (!href || !href.startsWith("/") || href.startsWith("//")) return null;
  // A query or hash would be dropped by an in-place switch (campaign params,
  // an anchor); let the router keep them.
  if (/[?#]/.test(href)) return null;
  const path = href.length > 1 && href.endsWith("/") ? href.slice(0, -1) : href;
  if (path === "/") return { kind: "home" };
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 1) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(parts[0]);
  } catch {
    return null;
  }
  return isLocationSlug(slug) ? { kind: "slug", slug } : null;
}

/** The pathname a target lives at. */
export function pathOfTarget(target: PlaceTarget): string {
  return target.kind === "home" ? "/" : `/${target.slug}`;
}

/** The tab title for a place (same wording as the server's `generateMetadata`). */
export function placeDocumentTitle(name: string): string {
  return `${name} Weather Today — Forecast & Conditions | mukoko weather`;
}
