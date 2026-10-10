import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

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
  // A missing top-level file (`/favicon-48.png`, `/old-logo.svg`, ...) would
  // otherwise fall through to the `[location]` route, which renders "Location
  // not found" with HTTP 200 (the not-found is streamed after the 200 starts).
  // Location slugs never contain a dot, so any single-segment dotted path that
  // isn't a real public file or a static route goes to a plain 404 handler.
  // `afterFiles` runs after public files and static routes (robots.txt,
  // sitemap.xml, manifest.json and so on) but before dynamic routes.
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [
        {
          source: "/:file([^/]*\\.[A-Za-z0-9]+)",
          destination: "/api/missing-asset",
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
