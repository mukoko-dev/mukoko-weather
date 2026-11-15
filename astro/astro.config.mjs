// Phase 0 of the move to Astro (mukoko-dev/mukoko-weather#475).
//
// This app is the strangler: it sits beside the Next.js app in ../src, reuses
// its pure modules and its Mzizi components unchanged, and serves nothing yet.
// The Next.js app still owns every route, the Vercel project and DNS.
//
// The ONLY places this app differs from how ../src is written are the five
// aliases below (src/shims): `next/link`, `next/navigation`, `@/lib/store`,
// `@/lib/analytics` and the account control (`PhoneMenu`). That list is the
// whole cost of reusing a Next-written component here; it must not grow
// without a reason written next to it.
import { fileURLToPath } from "node:url";
import {
  defineConfig,
  fontProviders,
  passthroughImageService,
} from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  site: "https://weather.mukoko.com",
  // STATIC output and no adapter, on purpose (mukoko-dev/mukoko-weather#579,
  // owner decision: "Rust serves it, JS only in the browser"). `astro build`
  // writes plain files into dist/ and nothing that runs on a server: no
  // `_worker.js`, no server bundle, no runtime config. The Rust Worker in
  // ../workers/web serves those files and owns routing, headers and caching.
  // A page that needs a server is not an Astro page here: it prerenders, or
  // Rust renders it. scripts/check-artefact.mjs fails the build if an adapter
  // or a server bundle comes back.
  output: "static",
  integrations: [react()],
  // No image is optimised here, and sharp is a Node dependency.
  image: { service: passthroughImageService() },
  // WorkOS keeps its own sealed cookie (phase 3); nothing here uses Astro
  // sessions.
  session: false,
  // The Next.js app's URLs have no trailing slash (`/about`, and the canonical
  // links say so). `file` writes about.html, which the Rust Worker (../workers/web) serves
  // at `/about`; `directory` would write about/index.html and answer `/about`
  // with a redirect to `/about/`.
  trailingSlash: "never",
  build: { format: "file" },
  fonts: [
    {
      provider: fontProviders.fontsource(),
      name: "Noto Sans",
      cssVariable: "--font-noto-sans",
      weights: ["400 700"],
      styles: ["normal"],
      subsets: ["latin"],
      fallbacks: ["system-ui", "sans-serif"],
    },
    {
      provider: fontProviders.fontsource(),
      name: "Noto Serif",
      cssVariable: "--font-noto-serif",
      weights: ["400 700"],
      styles: ["normal"],
      subsets: ["latin"],
      fallbacks: ["Georgia", "serif"],
    },
  ],
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: [
        {
          find: /^next\/link$/,
          replacement: here("./src/shims/next-link.tsx"),
        },
        {
          find: /^next\/navigation$/,
          replacement: here("./src/shims/next-navigation.tsx"),
        },
        {
          find: /^@\/lib\/store$/,
          replacement: here("./src/shims/store.ts"),
        },
        {
          find: /^@\/lib\/analytics$/,
          replacement: here("./src/shims/analytics.ts"),
        },
        {
          find: /^@\/components\/layout\/PhoneMenu$/,
          replacement: here("./src/shims/PhoneMenu.tsx"),
        },
        { find: /^@\//, replacement: here("../src/") },
      ],
      // ../src resolves its own node_modules (the Next app's), this app has
      // another: one React, or hooks break.
      dedupe: ["react", "react-dom", "lucide-react"],
    },
    server: { fs: { allow: [here("..")] } },
    build: { sourcemap: process.env.ASTRO_SOURCEMAP === "1" },
  },
});
