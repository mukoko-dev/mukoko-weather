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
 * 302 to the Vercel login page, which `fetch` followed to a 200 HTML page, so
 * every SSR cache miss silently fell back to direct Open-Meteo. Resolution:
 *
 * 1. `INTERNAL_API_BASE_URL` — an explicit override always wins (set it per
 *    Vercel environment; it is not set today).
 * 2. On Vercel with `VERCEL_AUTOMATION_BYPASS_SECRET` (injected when
 *    "Protection Bypass for Automation" is on) — this deployment's own
 *    `VERCEL_URL` plus the bypass header, so the Next.js and Python halves
 *    of one deployment always talk to each other.
 * 3. Production without the secret — `SITE_URL`. Custom domains are not
 *    protected; this reaches the promoted production deployment.
 * 4. Preview without the secret — `VERCEL_URL` (the protection redirect is
 *    then logged by name; previews need the bypass to reach their Python).
 * 5. Local — `http://localhost:3000`.
 */
export function internalApiTarget(env: Env = process.env): InternalApiTarget {
  if (env.INTERNAL_API_BASE_URL) {
    return { base: env.INTERNAL_API_BASE_URL.replace(/\/+$/, ""), headers: {} };
  }
  const secret = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (env.VERCEL_URL && secret) {
    return {
      base: `https://${env.VERCEL_URL}`,
      headers: { [PROTECTION_BYPASS_HEADER]: secret },
    };
  }
  if (env.VERCEL_ENV === "production") return { base: SITE_URL, headers: {} };
  if (env.VERCEL_URL) return { base: `https://${env.VERCEL_URL}`, headers: {} };
  return { base: "http://localhost:3000", headers: {} };
}
