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
  async headers() {
    return [
      {
        // The service worker script must never be served stale — always
        // revalidate so a new deploy's /sw.js is fetched, letting the
        // ServiceWorkerUpdater detect the new version and auto-reload.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
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
