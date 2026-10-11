/**
 * GA4 page hits with a sanitised location (framework-agnostic).
 *
 * `sendSanitisedPageView` first `set`s page_location / page_title /
 * page_referrer, which GA4 applies to every later hit (clicks, scrolls,
 * engagement), then sends page_view. Fine spot geohashes and location query
 * params never reach GA4; utm_* / gclid attribution is kept.
 */
import { sanitizePath, sanitizeUrl } from "./location-privacy";

export type Gtag = (...args: unknown[]) => void;

export interface PageHitEnv {
  origin: string;
  /** Raw pathname plus search, as the browser has it. */
  pathname: string;
  search: string;
  title: string;
  referrer: string;
}

/** The sanitised fields GA4 should see for this page. */
export function pageHitFields(env: PageHitEnv): {
  page_path: string;
  page_location: string;
  page_title: string;
  page_referrer: string;
} {
  const safePath = sanitizePath(env.pathname || "/");
  const fine = safePath !== (env.pathname || "/");
  const location = sanitizeUrl(`${env.origin}${env.pathname}${env.search}`);
  return {
    page_path: safePath,
    page_location: location || `${env.origin}${safePath}`,
    page_title: fine ? "mukoko weather" : env.title,
    page_referrer: sanitizeUrl(env.referrer),
  };
}

export function sendSanitisedPageView(gtag: Gtag, env: PageHitEnv): void {
  const fields = pageHitFields(env);
  gtag("set", {
    page_location: fields.page_location,
    page_title: fields.page_title,
    page_referrer: fields.page_referrer,
  });
  gtag("event", "page_view", fields);
}
