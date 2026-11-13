/**
 * `@/lib/analytics` for this app (one of the five seams in astro.config.mjs).
 *
 * Analytics move in phase 4 of #475 (GA4 stays, Vercel Analytics is dropped).
 * Until then the shell sends no events: this keeps `@vercel/analytics` out of
 * the bundle, and a place change made from the lane is simply not counted here
 * (nothing is served from this app yet, so nothing is lost).
 */
export function trackEvent(_name: string, _props?: unknown): void {}
