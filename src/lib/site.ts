/**
 * Site-wide origin constants. Import these instead of re-typing the domain.
 *
 * Edge-safe: reads only `process.env`, no Node-only imports.
 */

/** Canonical public origin — canonical URLs, JSON-LD, sitemap, OG, robots. */
export const SITE_URL = "https://weather.mukoko.com";

/** Header Vercel checks to let automation past Deployment Protection. */
export const PROTECTION_BYPASS_HEADER = "x-vercel-protection-bypass";

/** Where a server-to-self call goes, and the headers it needs to get there. */
export interface InternalApiTarget {
  base: string;
  headers: Record<string, string>;
}

type Env = Record<string, string | undefined>;

/**
 * Target for server-to-server calls into our own deployment (the Python
 * FastAPI functions live behind the same origin via vercel.json rewrites).
 *
 * Issue #262: the per-deployment host (`VERCEL_URL`) sits behind Vercel
 * Authentication ("all except custom domains"). A self-fetch to it gets a
 * 302 to the Vercel login page, which `fetch` follows to a 200 HTML page, so
 * every SSR cache miss silently fell back to direct Open-Meteo. Resolution:
 *
 * 1. `INTERNAL_API_BASE_URL` — an explicit override always wins.
 * 2. Production — the production domain (`VERCEL_PROJECT_PRODUCTION_URL`,
 *    else `SITE_URL`). Custom domains are not protected.
 * 3. Preview / development on Vercel — `VERCEL_URL`, plus the protection
 *    bypass header when Vercel injects `VERCEL_AUTOMATION_BYPASS_SECRET`
 *    ("Protection Bypass for Automation" enabled on the project).
 * 4. Local — `http://localhost:3000`.
 */
export function internalApiTarget(env: Env = process.env): InternalApiTarget {
  if (env.INTERNAL_API_BASE_URL) {
    return { base: env.INTERNAL_API_BASE_URL.replace(/\/+$/, ""), headers: {} };
  }
  if (env.VERCEL_ENV === "production") {
    const host = env.VERCEL_PROJECT_PRODUCTION_URL;
    return { base: host ? `https://${host}` : SITE_URL, headers: {} };
  }
  if (env.VERCEL_URL) {
    const secret = env.VERCEL_AUTOMATION_BYPASS_SECRET;
    return {
      base: `https://${env.VERCEL_URL}`,
      headers: secret ? { [PROTECTION_BYPASS_HEADER]: secret } : {},
    };
  }
  return { base: "http://localhost:3000", headers: {} };
}

/** Base URL half of {@link internalApiTarget}. */
export function internalApiBase(env: Env = process.env): string {
  return internalApiTarget(env).base;
}
