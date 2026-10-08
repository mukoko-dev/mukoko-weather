/**
 * Site-wide origin constants. Import these instead of re-typing the domain.
 *
 * Edge-safe: reads only `process.env`, no Node-only imports.
 */

/** Canonical public origin — canonical URLs, JSON-LD, sitemap, OG, robots. */
export const SITE_URL = "https://weather.mukoko.com";

/**
 * Base URL for server-to-server calls into our own deployment (the Python
 * FastAPI functions live behind the same origin via vercel.json rewrites).
 *
 * Resolution: `VERCEL_URL` (per-deployment host) → `INTERNAL_API_BASE_URL` →
 * localhost. Callers whose self-fetch must reach the public origin (e.g. when
 * the per-deployment host sits behind Deployment Protection) should NOT use
 * this and should keep their own fixed base.
 */
export function internalApiBase(): string {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return process.env.INTERNAL_API_BASE_URL ?? "http://localhost:3000";
}
