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
 * beside it, with its source map when there is one. A module the worker names
 * but dist/ does not contain stops the run with a non-zero exit instead of
 * shipping a worker that cannot start.
 *
 * Usage: node scripts/copy-maplibre-worker.mjs [--from <maplibre-gl package
 * dir>] [--out-root <dir>]. The options exist so tests can run the script on
 * small synthetic packages; the npm scripts pass none.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The entry point the app loads (see maplibreWorkerUrl in map-layers.ts). */
export const WORKER_FILE = "maplibre-gl-worker.mjs";

/**
 * The relative module specifiers (`./x.mjs`, `../y.mjs`) a JavaScript module
 * imports or re-exports: static `import ... from "..."`, bare
 * `import "..."`, `export ... from "..."` and `import("...")`. The worker is
 * minified, so this reads specifiers by pattern rather than parsing the file.
 * Bare package names and absolute URLs are not relative to the file and are
 * left out.
 *
 * @param {string} source
 * @returns {string[]} distinct specifiers, in order of first appearance
 */
export function relativeImports(source) {
  const found = new Set();
  const patterns = [
    /\bfrom\s*(["'`])(\.{1,2}\/[^"'`]+)\1/g,
    /\bimport\s*(["'`])(\.{1,2}\/[^"'`]+)\1/g,
    /\bimport\s*\(\s*(["'`])(\.{1,2}\/[^"'`]+)\1\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[2]);
  }
  return [...found];
}

/**
 * Copies the worker and the relative modules it imports into
 * `<outRoot>/<version>/`, keeping their layout relative to dist/.
 *
 * @param {{ packageDir: string, outRoot: string }} options packageDir is the
 *   maplibre-gl package root (the folder holding package.json and dist/)
 * @returns {{ version: string, outDir: string, files: string[] }} files are
 *   the copied modules, relative to dist/, worker first
 */
export function copyWorker({ packageDir, outRoot }) {
  const { version } = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8"),
  );
  const dist = join(packageDir, "dist");
  const outDir = join(outRoot, version);

  /** @type {string[]} */
  const modules = []; // dist-relative paths, worker first
  /** @type {{ name: string, importer: string | null }[]} */
  const queue = [{ name: WORKER_FILE, importer: null }];
  while (queue.length > 0) {
    const { name, importer } = /** @type {(typeof queue)[number]} */ (
      queue.shift()
    );
    if (modules.includes(name)) continue;
    const from = join(dist, name);
    if (!existsSync(from) || !statSync(from).isFile()) {
      throw new Error(
        `maplibre-gl ${version}: ${name} is missing from ${dist}` +
          (importer ? ` but ${importer} imports it` : "") +
          `. Without it the map worker cannot start.`,
      );
    }
    modules.push(name);
    for (const specifier of relativeImports(readFileSync(from, "utf8"))) {
      // A URL may carry a query or fragment; the file does not.
      const target = relative(
        dist,
        resolve(dirname(from), specifier.replace(/[?#].*$/, "")),
      );
      if (
        target === "" ||
        target === ".." ||
        target.startsWith(`..${sep}`) ||
        isAbsolute(target)
      ) {
        throw new Error(
          `maplibre-gl ${version}: ${name} imports "${specifier}", which is outside dist/.`,
        );
      }
      queue.push({ name: target.split(sep).join("/"), importer: name });
    }
  }

  const files = [];
  for (const name of modules) {
    const to = join(outDir, name);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(dist, name), to);
    files.push(name);
    // The copies keep their sourceMappingURL comments; ship the maps beside them.
    if (existsSync(join(dist, `${name}.map`))) {
      copyFileSync(join(dist, `${name}.map`), `${to}.map`);
    }
  }
  return { version, outDir, files };
}

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
  const packageDir =
    options.from ??
    dirname(
      createRequire(join(root, "package.json")).resolve(
        "maplibre-gl/package.json",
      ),
    );
  const outRoot =
    options.outRoot ?? join(root, "public", "vendor", "maplibre-gl");

  const { version, outDir, files } = copyWorker({ packageDir, outRoot });
  const shown = relative(root, outDir).split(sep).join("/");
  console.log(
    `maplibre-gl ${version}: worker copied to ${shown.startsWith("..") ? outDir : shown}/ (${files.join(", ")})`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
