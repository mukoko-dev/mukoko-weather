import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";
import {
  MISSING_ASSET_DESTINATION,
  MISSING_ASSET_SOURCE,
} from "./src/lib/missing-asset";

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
        // Allow embed endpoints to be loaded from any origin
        source: "/embed/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, OPTIONS" },
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
      {
        // API CORS headers
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type" },
        ],
      },
    ];
  },
};

export default withSerwist(nextConfig);
