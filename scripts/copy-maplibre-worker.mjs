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
 * This copies both files (plus their source maps) into
 * public/vendor/maplibre-gl/<version>/, and MapLibreMap points setWorkerUrl()
 * at the copy for the version it is running (maplibreWorkerUrl() in
 * map-layers.ts, fed by maplibre-gl's own getVersion()). The version in the
 * path means a tab still running an older bundle after a deploy keeps loading
 * a matching worker instead of a newer one with a different message protocol.
 * Runs before `next build` and `next dev` (package.json prebuild/predev).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const pkgPath = require.resolve("maplibre-gl/package.json");
const dist = join(dirname(pkgPath), "dist");
const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
const outDir = join(root, "public", "vendor", "maplibre-gl", version);

const WORKER_FILES = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

mkdirSync(outDir, { recursive: true });
for (const file of WORKER_FILES) {
  copyFileSync(join(dist, file), join(outDir, file));
  // The copies keep their sourceMappingURL comments; ship the maps beside them.
  if (existsSync(join(dist, `${file}.map`))) {
    copyFileSync(join(dist, `${file}.map`), join(outDir, `${file}.map`));
  }
}
console.log(
  `maplibre-gl ${version}: worker copied to public/vendor/maplibre-gl/${version}/`,
);
