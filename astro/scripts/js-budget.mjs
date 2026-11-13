// How much JavaScript a prerendered page needs, counted from the build: every
// file the page's HTML pulls in (module scripts, island components, their
// renderers) and every file those import statically. Counted in raw and gzip
// bytes; dynamic `import()` is listed apart because it loads later, on demand.
//
// Fails when a page goes over a budget in js-budget.json (JavaScript in gzip
// bytes, inline script in bytes, CSS in gzip bytes: CSS blocks first paint), so
// a change that adds to the shell has to say so in that file, in review.
//
//   node scripts/js-budget.mjs            check every budgeted page
//   node scripts/js-budget.mjs --json     print the numbers as JSON
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../dist/client", import.meta.url));
const BUDGETS = JSON.parse(
  await readFile(new URL("../js-budget.json", import.meta.url), "utf8"),
);

const ASSET = /\/_astro\/[^"'\s)]+\.js/g;
const STATIC_IMPORT =
  /(?:^|[;}\s])(?:import|export)\s*(?:[^"'`;()]*?from\s*)?["']([^"']+\.js)["']/g;
const DYNAMIC_IMPORT = /import\(\s*["']([^"']+\.js)["']\s*\)/g;

async function read(path) {
  return readFile(join(ROOT, path.replace(/^\//, "")));
}

/** Count the JavaScript the HTML of `route` needs at load. */
export async function measureRoute(route) {
  const html = (await read(`${route}.html`)).toString("utf8");
  const entries = new Set(html.match(ASSET) ?? []);
  const seen = new Map();
  const lazy = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    const code = await read(file);
    seen.set(file, {
      raw: code.length,
      gzip: gzipSync(code, { level: 9 }).length,
    });
    const text = code.toString("utf8");
    const resolveImport = (spec) =>
      spec.startsWith(".") ? posix.join(posix.dirname(file), spec) : spec;
    for (const m of text.matchAll(STATIC_IMPORT))
      queue.push(resolveImport(m[1]));
    for (const m of text.matchAll(DYNAMIC_IMPORT))
      lazy.add(resolveImport(m[1]));
  }
  const files = Object.fromEntries(seen);
  const total = { raw: 0, gzip: 0 };
  for (const f of seen.values()) {
    total.raw += f.raw;
    total.gzip += f.gzip;
  }
  const cssFiles = [...(html.match(/\/_astro\/[^"'\s)]+\.css/g) ?? [])];
  const css = { raw: 0, gzip: 0 };
  for (const file of new Set(cssFiles)) {
    const code = await read(file);
    css.raw += code.length;
    css.gzip += gzipSync(code, { level: 9 }).length;
  }
  const inline = [
    ...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g),
  ]
    .map((m) => m[1])
    .reduce((n, s) => n + Buffer.byteLength(s), 0);
  return {
    route,
    js: total,
    jsFiles: files,
    inlineScriptBytes: inline,
    css,
    lazy: [...lazy].filter((f) => !seen.has(f)),
    html: { raw: html.length, gzip: gzipSync(html, { level: 9 }).length },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = [];
  let failed = false;
  for (const [route, budget] of Object.entries(BUDGETS.routes)) {
    const r = await measureRoute(route);
    results.push(r);
    if (process.argv.includes("--json")) continue;
    const over =
      r.js.gzip > budget.jsGzipBytes ||
      r.inlineScriptBytes > budget.inlineScriptBytes ||
      r.css.gzip > budget.cssGzipBytes;
    failed ||= over;
    console.log(
      `${over ? "FAIL" : "ok  "} ${route}  JS ${r.js.raw} B raw, ${r.js.gzip} B gzip (budget ${budget.jsGzipBytes})  inline JS ${r.inlineScriptBytes} B (budget ${budget.inlineScriptBytes})  CSS ${r.css.raw} B raw, ${r.css.gzip} B gzip (budget ${budget.cssGzipBytes})  HTML ${r.html.gzip} B gzip`,
    );
    for (const [file, size] of Object.entries(r.jsFiles)) {
      console.log(
        `     ${String(size.raw).padStart(7)} raw ${String(size.gzip).padStart(6)} gz  ${file}`,
      );
    }
    if (r.lazy.length)
      console.log(`     loaded later, on demand: ${r.lazy.join(", ")}`);
  }
  if (process.argv.includes("--json"))
    console.log(JSON.stringify(results, null, 2));
  process.exit(failed ? 1 : 0);
}
