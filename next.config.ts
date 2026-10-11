import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";
import {
  MISSING_ASSET_DESTINATION,
  MISSING_ASSET_SOURCE,
} from "./src/lib/missing-asset";

import {
  BASELINE_HEADERS,
  CORS_POLICY,
  FRAMEABLE_PATHS,
  FRAME_HEADER,
  buildCsp,
} from "./src/lib/security-headers";

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
});

const nextConfig: NextConfig = {
  // @serwist/next uses a webpack plugin — tell Next.js 16 to accept both configs
  turbopack: {
    // Silence the multiple-lockfiles warning — parent dir has a lockfile from oss-weather
    root: __dirname,
  },
  // A missing top-level file (`/favicon-48.png`, `/old-logo.svg`, ...) goes
  // to a plain 404 instead of the `[location]` route's streamed 200. The
  // pattern and the reasoning are in src/lib/missing-asset.ts.
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [
        {
          source: MISSING_ASSET_SOURCE,
          destination: MISSING_ASSET_DESTINATION,
        },
      ],
      fallback: [],
    };
  },
  async headers() {
    return [
      {
        // Baseline security headers on every response (B05).
        source: "/:path*",
        headers: BASELINE_HEADERS,
      },
      {
        // Frame policy: same-origin only, except the embeddable widget/docs
        // and the kiosk display (their own rules follow).
        source: `/((?!(?:${FRAMEABLE_PATHS.join("|")})(?:/|$)).*)`,
        headers: [FRAME_HEADER],
      },
      {
        // CSP in REPORT-ONLY mode: nothing is blocked; violations go to
        // /api/csp-report. Skips static assets and API responses.
        source: "/((?!_next/|api/).*)",
        headers: [
          {
            key: "Content-Security-Policy-Report-Only",
            value: buildCsp(),
          },
        ],
      },
      {
        // The service worker script must never be served stale — always
        // revalidate so a new deploy's /sw.js is fetched, letting the
        // ServiceWorkerUpdater detect the new version and auto-reload.
        source: "/sw.js",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        // The iframe widget target must be embeddable on ANY third-party site.
        // The app sets no X-Frame-Options (so framing is already allowed); this
        // makes it explicit and future-proof via CSP frame-ancestors.
        source: "/embed/widget",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors *" },
        ],
      },
      // CORS (B06): `*` (no credentials) only on the documented public read
      // API and the embed endpoints. Everything else under /api/py is
      // answered by FastAPI's allowlist; /api/ai, /api/keys, /api/db-init are
      // same-origin. Policy data: CORS_POLICY in src/lib/security-headers.ts.
      ...CORS_POLICY.open.map((source) => ({
        source,
        headers: [...CORS_POLICY.headers],
      })),
    ];
  },
};

export default withSerwist(nextConfig);
