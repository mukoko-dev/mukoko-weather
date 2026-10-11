/**
 * Security response headers (B05). Pure data so next.config.ts and its test
 * share one source of truth.
 *
 * The CSP ships as Content-Security-Policy-Report-Only: violations are POSTed
 * to /api/csp-report and logged, nothing is blocked. Enforce plan is in
 * CLAUDE.md (Security headers).
 */

/** Where report-only violations are sent (same-origin, see api/csp-report). */
export const CSP_REPORT_PATH = "/api/csp-report";

const GA = [
  "https://www.googletagmanager.com",
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
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
  "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
  "img-src": [
    "'self'",
    "data:",
    "blob:",
    "https://api.maptiler.com",
    "https://*.maptiler.com",
    "https://gibs.earthdata.nasa.gov",
    "https://*.googleusercontent.com",
    "https://*.workoscdn.com",
    ...GA,
  ],
  "connect-src": [
    "'self'",
    "https://api.maptiler.com",
    "https://*.maptiler.com",
    "https://api.open-meteo.com",
    "https://api.tomorrow.io",
    "https://gibs.earthdata.nasa.gov",
    "https://api.workos.com",
    "https://*.authkit.app",
    "https://va.vercel-scripts.com",
    "https://vitals.vercel-insights.com",
    ...GA,
  ],
  "worker-src": ["'self'", "blob:"],
  "child-src": ["'self'", "blob:"],
  "frame-src": ["'self'"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "manifest-src": ["'self'"],
};

export function buildCsp(reportPath: string = CSP_REPORT_PATH): string {
  const parts = Object.entries(CSP_DIRECTIVES).map(
    ([k, v]) => `${k} ${v.join(" ")}`,
  );
  parts.push(`report-uri ${reportPath}`);
  return parts.join("; ");
}

export const PERMISSIONS_POLICY =
  "geolocation=(self), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()";

/** Paths that stay frameable: the embed widget/docs and the kiosk display. */
export const FRAMEABLE_PATHS = ["embed", "display"];

export const BASELINE_HEADERS = [
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
];

export const FRAME_HEADER = { key: "X-Frame-Options", value: "SAMEORIGIN" };

/** Origins allowed to call the first-party API cross-origin (Python CORS list). */
export const FIRST_PARTY_ORIGINS = [
  "https://weather.mukoko.com",
  "https://weatherstations.nyuchi.com",
  "http://localhost:3000",
];

/**
 * CORS policy as data (framework-agnostic, reusable by the Astro/Workers app).
 * `open` paths answer `Access-Control-Allow-Origin: *`; everything else is
 * same-origin plus {@link FIRST_PARTY_ORIGINS}, echoed by the API layer.
 */
export const CORS_POLICY = {
  open: ["/api/embed/*", "/embed/*"],
  allowlist: FIRST_PARTY_ORIGINS,
  /** Hardware ingest is not a browser: no CORS needed. */
  noCors: ["/api/py/stations/ingest"],
} as const;
