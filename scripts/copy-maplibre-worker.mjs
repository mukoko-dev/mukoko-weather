#!/usr/bin/env node
/**
 * Serves MapLibre GL's web worker from /public.
 *
 * Since v6, maplibre-gl ships its worker as a separate ES module
 * (maplibre-gl-worker.mjs, which imports maplibre-gl-shared.mjs) and, by
 * default, loads it from next to wherever maplibre-gl.mjs itself was loaded.
 * Webpack bundles maplibre-gl.mjs into a /_next/static/chunks/ file and does
 * not emit the worker beside it, so the default URL 404s, the worker never
 * starts ("Worker failed to load") and every map renders blank.
 *
 * This copies both files into public/vendor/maplibre-gl/, and MapLibreMap
 * points setWorkerUrl() at the copy (MAPLIBRE_WORKER_URL in map-layers.ts).
 * Runs before `next build` and `next dev` (package.json prebuild/predev), so
 * the copy always matches the installed maplibre-gl version.
 */
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const pkgPath = require.resolve("maplibre-gl/package.json");
const dist = join(dirname(pkgPath), "dist");
const outDir = join(root, "public", "vendor", "maplibre-gl");

const WORKER_FILES = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

mkdirSync(outDir, { recursive: true });
for (const file of WORKER_FILES) {
  copyFileSync(join(dist, file), join(outDir, file));
}
const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
console.log(`maplibre-gl ${version}: worker copied to public/vendor/maplibre-gl/`);
