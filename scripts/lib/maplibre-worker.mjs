/**
 * The decisions behind scripts/copy-maplibre-worker.mjs, kept apart from the
 * command-line entry so tests can import them. This module only defines
 * functions; importing it never copies anything. The entry file always runs,
 * which keeps "was this file started directly?" out of the picture: that check
 * compares the symlink-preserving argv[1] with the real path Node puts in
 * import.meta.url and silently skipped the copy when scripts/ was reached
 * through a symlink.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The entry point the app loads (see maplibreWorkerUrl in map-layers.ts). */
export const WORKER_FILE = "maplibre-gl-worker.mjs";

/**
 * A package version we are willing to use as a folder name: it starts with a
 * letter or digit and has no path separator, so `<out root>/<version>` is
 * always one folder directly under the out root.
 */
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;

/**
 * The relative module specifiers (`./x.mjs`, `../y.mjs`) a JavaScript module
 * imports or re-exports: static `import ... from "..."`, bare
 * `import "..."`, `export ... from "..."` and `import("...")` with a string
 * literal. The worker is minified, so this reads specifiers by pattern rather
 * than parsing the file. Bare package names and absolute URLs are not relative
 * to the file and are left out.
 *
 * @param {string} source
 * @returns {string[]} distinct specifiers, in order of first appearance
 */
export function relativeImports(source) {
  /** @type {{ index: number, specifier: string }[]} */
  const matches = [];
  const patterns = [
    /\bfrom\s*(["'`])(\.{1,2}\/[^"'`]+)\1/g,
    /\bimport\s*(["'`])(\.{1,2}\/[^"'`]+)\1/g,
    /\bimport\s*\(\s*(["'`])(\.{1,2}\/[^"'`]+)\1\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      matches.push({ index: match.index ?? 0, specifier: match[2] });
    }
  }
  // Each pattern was scanned on its own; put the matches back in file order.
  matches.sort((a, b) => a.index - b.index);
  return [...new Set(matches.map((match) => match.specifier))];
}

/**
 * Copies the worker and the relative modules it imports into
 * `<outRoot>/<version>/`, keeping their layout relative to dist/. That folder
 * is replaced, not added to: whatever an earlier run left in it is removed
 * first, so a leftover file (say a `maplibre-gl-shared.mjs` from the previous
 * layout) can never sit beside a new worker and hide a module that is really
 * missing. Nothing outside the folder is touched, and the folder is only
 * replaced once every module the worker needs has been found, so a broken
 * package leaves the previous copy as it was.
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
  if (typeof version !== "string" || !SAFE_VERSION.test(version)) {
    throw new Error(
      `maplibre-gl package.json has a version this script will not use as a folder name: ${JSON.stringify(version)}.`,
    );
  }
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

  // Everything is accounted for: replace the folder, then fill it.
  rmSync(outDir, { recursive: true, force: true });
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

/**
 * The maplibre-gl package the repository has installed (the folder holding its
 * package.json and dist/).
 *
 * @param {string} root the repository root
 * @returns {string}
 */
export function defaultPackageDir(root) {
  return dirname(
    createRequire(join(root, "package.json")).resolve(
      "maplibre-gl/package.json",
    ),
  );
}

/**
 * Where the npm scripts write: public/vendor/maplibre-gl, which Next.js serves
 * as /vendor/maplibre-gl/<version>/... (see maplibreWorkerUrl in
 * map-layers.ts).
 *
 * @param {string} root the repository root
 * @returns {string}
 */
export function defaultOutRoot(root) {
  return join(root, "public", "vendor", "maplibre-gl");
}
