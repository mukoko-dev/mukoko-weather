/**
 * Security response headers (B05). Pure data so next.config.ts and its test
 * share one source of truth.
 *
 * The CSP ships as Content-Security-Policy-Report-Only: violations are POSTed
 * to /api/csp-report and logged, nothing is blocked. Enforce plan is in
 * CLAUDE.md (Security headers).
 */

import { parseBareOrigin } from "./bare-origin";

/** Where report-only violations are sent (same-origin, see api/csp-report). */
export const CSP_REPORT_PATH = "/api/csp-report";

const GA = [
  "https://www.googletagmanager.com",
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
];

/** Other hosts GA4 / Google Tag use for measurement and pixels. */
const GA_EXTRA = [
  "https://*.googletagmanager.com",
  "https://*.g.doubleclick.net",
  "https://www.google.com",
];

export const CSP_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'self'"],
  // Next.js emits inline bootstrap scripts and the theme/JSON-LD scripts; a
  // nonce rollout is the enforce-phase work.
  "script-src": [
    "'self'",
    "'unsafe-inline'",
    "https://va.vercel-scripts.com",
    GA[0],
  ],
  // Fonts are self-hosted through next/font (src/app/layout.tsx): no Google
  // Fonts origin is needed.
  "style-src": ["'self'", "'unsafe-inline'"],
  "font-src": ["'self'", "data:"],
  "img-src": [
    "'self'",
    "data:",
    "blob:",
    "https://api.maptiler.com",
    "https://*.maptiler.com",
    "https://gibs.earthdata.nasa.gov",
    // Weather overlay tiles from the Rust tiles Worker (src/lib/map-layers.ts).
    "https://weather-tiles.mukoko.com",
    "https://*.googleusercontent.com",
    "https://*.workoscdn.com",
    "https://avatars.githubusercontent.com",
    ...GA,
    ...GA_EXTRA,
  ],
  "connect-src": [
    "'self'",
    "https://api.maptiler.com",
    "https://*.maptiler.com",
    "https://api.open-meteo.com",
    // The Rust weather Worker (NEXT_PUBLIC_WEATHER_API_URL, src/lib/weather-api.ts).
    "https://weather-api.mukoko.com",
    "https://weather-tiles.mukoko.com",
    // CouchDB sync replicates with the Nyuchi API (src/lib/rxdb/couch-sync.ts),
    // only while FLAGS.couch_sync is on; the origin comes from /api/couch/session.
    "https://api.nyuchi.com",
    "https://api.tomorrow.io",
    "https://gibs.earthdata.nasa.gov",
    "https://api.workos.com",
    "https://*.authkit.app",
    "https://va.vercel-scripts.com",
    "https://vitals.vercel-insights.com",
    ...GA,
    ...GA_EXTRA,
  ],
  "worker-src": ["'self'", "blob:"],
  "child-src": ["'self'", "blob:"],
  "frame-src": ["'self'"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "manifest-src": ["'self'"],
};

/**
 * The Nyuchi API origin the CouchDB sync replicates with, from the environment
 * the CALLER passes (`next.config.ts` hands over the process's variables; this
 * module reads none, so the table stays pure data): the value `NYUCHI_API_URL`
 * has, by the same rule `/api/couch/session` applies before it hands the
 * origin to the page. Empty when the variable is unset or unusable (the route
 * answers 503 then). The default entry in `connect-src` above is the
 * production origin; this keeps the CSP matching the host the page is actually
 * told about when the variable points somewhere else (a staging gateway).
 */
export function couchApiConnectSrc(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const origin = parseBareOrigin(env.NYUCHI_API_URL?.trim());
  return origin ? [origin] : [];
}

/**
 * The policy string. `extraConnectSrc` adds hosts to `connect-src` only (and
 * never twice); everything else is the table.
 */
export function buildCsp(
  reportPath: string = CSP_REPORT_PATH,
  extraConnectSrc: readonly string[] = [],
): string {
  const directives: Record<string, string[]> = {
    ...CSP_DIRECTIVES,
    "connect-src": [
      ...new Set([...CSP_DIRECTIVES["connect-src"], ...extraConnectSrc]),
    ],
  };
  const parts = Object.entries(directives).map(
    ([k, v]) => `${k} ${v.join(" ")}`,
  );
  parts.push(`report-uri ${reportPath}`);
  return parts.join("; ");
}

export const PERMISSIONS_POLICY =
  "geolocation=(self), camera=(), microphone=(), payment=(), usb=()";

/** Paths that stay frameable: the embed widget/docs and the kiosk display. */
export const FRAMEABLE_PATHS = ["embed", "display"];

export const BASELINE_HEADERS = [
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
];

export const FRAME_HEADER = { key: "X-Frame-Options", value: "SAMEORIGIN" };

/**
 * Origins allowed to call the first-party API cross-origin: the Workers'
 * `CORS_ORIGINS` (`workers/public-api` and `workers/stations`), which echo the
 * origin themselves. This table is the data the tests and the docs check them
 * against; nothing on Vercel answers a cross-origin API call any more.
 */
export const FIRST_PARTY_ORIGINS = [
  "https://weather.mukoko.com",
  "https://weatherstations.nyuchi.com",
  "http://localhost:3000",
];

/**
 * CORS policy as data (framework-agnostic, reusable by the Astro/Workers app).
 *
 * `open` routes are the embed endpoints: `Access-Control-Allow-Origin: *`,
 * never with credentials. The documented public browser API (developers page:
 * weather, air quality, geo and search) is on the Rust API Worker now
 * (`weather_core::cors::OPEN_READ_ROUTES`), which carries the same policy.
 * Every other route is same-origin here; the Workers echo
 * {@link FIRST_PARTY_ORIGINS} on their own routes.
 */
export const CORS_POLICY = {
  open: ["/api/embed/:path*", "/embed/:path*"],
  allowlist: FIRST_PARTY_ORIGINS,
  /**
   * Hardware ingest is not a browser: no CORS needed. This is the one
   * `/api/py` path left: the upload URL consoles in the field are configured
   * with, which `vercel.json` rewrites to the stations Worker (and that Worker
   * also takes as a route on this host).
   */
  noCors: ["/api/py/stations/ingest"],
  headers: [
    { key: "Access-Control-Allow-Origin", value: "*" },
    { key: "Access-Control-Allow-Methods", value: "GET, OPTIONS" },
    { key: "Access-Control-Allow-Headers", value: "Content-Type" },
  ],
} as const;
