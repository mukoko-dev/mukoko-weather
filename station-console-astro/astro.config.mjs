import cloudflare from "@astrojs/cloudflare";
import tailwindcss from "@tailwindcss/vite";
import authkit from "@workos/authkit-astro";
import { defineConfig, envField } from "astro/config";

import { mockAuth } from "./integrations/mock-auth.mjs";

// AUTH_MODE=mock swaps WorkOS for a cookie session so the UI and the
// Playwright smoke run without credentials. It is refused on Workers Builds
// and in any production runtime (see src/auth/mock-middleware.ts).
const authMode = process.env.AUTH_MODE === "mock" ? "mock" : "workos";

const auth =
  authMode === "mock"
    ? mockAuth()
    : authkit({
        // The BFF answers 401 JSON to fetch(); pages decide for themselves
        // (anonymous visitors get the landing page at "/").
        protectedRoutes: ["/api/stations"],
        signInPath: "/auth/signin",
        loginPath: "/auth/signin",
        logoutPath: "/auth/logout",
        callbackPath: "/callback",
        afterSignOutUrl: "/",
        hydrateClient: false,
      });

export default defineConfig({
  output: "server",
  adapter: cloudflare({ imageService: "passthrough" }),
  session: false,
  integrations: [auth],
  vite: { plugins: [tailwindcss()] },
  security: { checkOrigin: true },
  env: {
    schema: {
      // Shown in the hardware setup instructions: the same host the stations
      // in the field already use.
      PUBLIC_STATIONS_INGEST_HOST: envField.string({
        context: "client",
        access: "public",
        default: "weather.mukoko.com",
      }),
      STATIONS_BACKEND: envField.enum({
        context: "server",
        access: "public",
        values: ["mock", "nyuchi"],
        default: "mock",
      }),
      NYUCHI_API_URL: envField.string({
        context: "server",
        access: "public",
        optional: true,
      }),
    },
  },
});
