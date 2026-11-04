#!/usr/bin/env node
/**
 * Serves MapLibre GL's web worker from /public.
 *
 * Since v6, maplibre-gl ships its worker as a separate ES module
 * (maplibre-gl-worker.mjs) and, by default, loads it from next to wherever
 * maplibre-gl.mjs itself was loaded. Webpack bundles maplibre-gl.mjs into a
 * /_next/static/chunks/ file and does not emit the worker beside it, so the
 * default URL 404s, the worker never starts ("Worker failed to load") and
 * every map renders blank.
 *
 * This copies the worker into public/vendor/maplibre-gl/<version>/, and
 * MapLibreMap points setWorkerUrl() at the copy for the version it is running
 * (maplibreWorkerUrl() in map-layers.ts, fed by maplibre-gl's own
 * getVersion()). The version in the path means a tab still running an older
 * bundle after a deploy keeps loading a matching worker instead of a newer one
 * with a different message protocol. Runs before `next build` and `next dev`
 * (package.json prebuild/predev).
 *
 * What gets copied is decided by what the worker file actually imports, never
 * by a version number, because the package has shipped two layouts:
 *
 *   - two files (6.12.0, the last of them): a thin maplibre-gl-worker.mjs that
 *     does `import { ... } from "./maplibre-gl-shared.mjs"`, where the shared
 *     module holds the whole library;
 *   - one file (6.13.0 and later, checked through 6.16.0): a self-contained
 *     maplibre-gl-worker.mjs with nothing imported. dist/ still lists an EMPTY
 *     maplibre-gl-shared.mjs there (the package's build script writes a
 *     placeholder), which nothing refers to, so it is not copied.
 *
 * Every relative module the worker pulls in (followed transitively) is copied
 * beside it, with its source map when there is one, into a version folder that
 * is replaced on every run. A module the worker names but dist/ does not
 * contain stops the run with a non-zero exit instead of shipping a worker that
 * cannot start.
 *
 * Limit: specifiers are found by pattern in the minified file, and only string
 * literals count (`import "./x.mjs"`, `from "./x.mjs"`, `import("./x.mjs")`).
 * A module named at run time (`import(name)`, `new URL(name, import.meta.url)`)
 * is not followed. The worker has never used those forms; if a release did,
 * the installed-package check in MapLibreMap.test.ts (run on every maplibre-gl
 * bump) is where it would show.
 *
 * Usage: node scripts/copy-maplibre-worker.mjs [--from <maplibre-gl package
 * dir>] [--out-root <dir>]. The options exist so tests can run the script on
 * small synthetic packages; the npm scripts pass none. The logic lives in
 * scripts/lib/maplibre-worker.mjs; this entry always runs it.
 */
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyWorker,
  defaultOutRoot,
  defaultPackageDir,
} from "./lib/maplibre-worker.mjs";

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ from?: string, outRoot?: string }} */
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== "--from" && flag !== "--out-root") || !value) {
      throw new Error(
        "usage: copy-maplibre-worker.mjs [--from <maplibre-gl package dir>] [--out-root <dir>]",
      );
    }
    if (flag === "--from") options.from = resolve(value);
    else options.outRoot = resolve(value);
  }
  return options;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const options = parseArgs(process.argv.slice(2));
  const packageDir = options.from ?? defaultPackageDir(root);
  const outRoot = options.outRoot ?? defaultOutRoot(root);

  const { version, outDir, files } = copyWorker({ packageDir, outRoot });
  const shown = relative(root, outDir).split(sep).join("/");
  console.log(
    `maplibre-gl ${version}: worker copied to ${shown.startsWith("..") ? outDir : shown}/ (${files.join(", ")})`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
