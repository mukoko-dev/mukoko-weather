/**
 * What the service worker precaches at install.
 *
 * `@serwist/next` hands the worker EVERY emitted asset: 225 entries, ~11 MB
 * (all JS chunks, including MapLibre, Three.js and the PDF renderer, plus 28
 * font subsets). Install runs on the first launch and again after every
 * deploy, with the page's own CSS/JS/font requests in flight, so on a phone
 * the precache and the first paint fight for the same bandwidth; the new
 * worker then takes control and `ServiceWorkerUpdater` reloads the page,
 * which pays for the cold load a second time.
 *
 * Only what an offline launch needs is precached. Everything else under
 * `/_next/static/` is cached on first use by the `static-assets` CacheFirst
 * route in `src/app/sw.ts`, so it costs nothing until it is actually used.
 */

type Entry = string | { url: string };

const urlOf = (entry: Entry): string =>
  typeof entry === "string" ? entry : entry.url;

/** True when an entry is worth downloading at install time. */
export function shouldPrecache(entry: Entry): boolean {
  const url = urlOf(entry).split("?")[0];
  // Stylesheets: the /offline fallback page needs them and they are small.
  if (url.startsWith("/_next/static/css/")) return true;
  // Everything else Next emits (chunks, fonts, build manifests) loads lazily.
  if (url.startsWith("/_next/")) return false;
  // Public icons/images only (favicons, app icons, grain texture). Text
  // files such as llms-full.txt are crawler files, not app shell.
  return /\.(?:png|ico|svg|webp)$/i.test(url);
}

export function precacheEntries<T extends Entry>(manifest: T[]): T[] {
  return manifest.filter(shouldPrecache);
}
