/**
 * Which pathnames this app serves, as data (the plan's "route manifest",
 * #293 section 2.2). The edge router, the client router's shims and the
 * sitemap read this one list; today the Next.js app serves everything else.
 *
 * `served` is what a visitor may be sent here for (nothing is, until the
 * owner points a route at this app). `preview` pages exist only to exercise
 * the shell and are never linked, indexed or routed.
 */
export const SERVED_ROUTES: readonly string[] = ["/about"];
export const PREVIEW_ROUTES: readonly string[] = ["/shell-preview"];

const OWNED = new Set([...SERVED_ROUTES, ...PREVIEW_ROUTES]);

/** The pathname of an href, or null for another origin, mailto: and the like. */
function pathOf(href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
  const [path] = href.split(/[?#]/);
  const clean = path === "" ? "/" : path;
  return clean.length > 1 ? clean.replace(/\/+$/, "") : clean;
}

/**
 * Whether this app can render `href` itself. A link to anything else must be
 * a full page load (`data-astro-reload`): the client router would otherwise
 * fetch a page of the other app and find it is not an Astro page.
 */
export function isAstroRoute(href: string): boolean {
  const path = pathOf(href);
  return path !== null && OWNED.has(path);
}
