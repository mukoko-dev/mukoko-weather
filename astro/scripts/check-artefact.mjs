// The gate for "Rust serves it, JS only in the browser" (mukoko-dev/mukoko-weather#579).
//
// The web build is two things and nothing else: static files (astro/dist) and
// the Rust Worker (workers/web) that serves them. This fails, with the reason,
// when either side grows a JavaScript server:
//
//   - the build output holds a server bundle (`_worker.js`, `dist/server`, an
//     adapter's `wrangler.json`, `entry.mjs`, `_routes.json`, a `functions/`
//     folder, `package.json`...), a `_headers` or `_redirects` file (headers
//     and redirects are the Rust Worker's, in one place), or any script that
//     imports a server runtime (`node:*`, `cloudflare:*`);
//   - a page the route table calls migrated is not in the build;
//   - the config brings a server back: an Astro adapter or `output` other than
//     "static", a Worker whose `main` is not the Rust build, one that is not
//     `run_worker_first`, one with a route or `workers_dev` on (it is dark), or
//     JavaScript or a package.json inside workers/web.
//
//   node scripts/check-artefact.mjs [dist]     (default: astro/dist)
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(here, "..", "..");

/** File names that only a server (or a Node/Vercel/Cloudflare project) has. */
const SERVER_FILES = new Map([
  ["_worker.js", "an advanced-mode Worker bundle"],
  ["_routes.json", "Cloudflare Pages routing config"],
  ["_headers", "static-asset header rules (headers are the Rust Worker's)"],
  [
    "_redirects",
    "static-asset redirect rules (redirects are the Rust Worker's)",
  ],
  ["wrangler.json", "a Worker config an adapter writes"],
  ["wrangler.jsonc", "a Worker config"],
  ["wrangler.toml", "a Worker config"],
  [".assetsignore", "an adapter's asset filter"],
  ["package.json", "a Node project"],
  ["package-lock.json", "a Node project"],
  ["vercel.json", "a Vercel project"],
  [".node-version", "a Node runtime pin"],
  ["entry.mjs", "an adapter's server entry"],
  ["renderers.mjs", "an adapter's server renderers"],
]);

/** Folders that only a server build has. */
const SERVER_DIRS = new Map([
  ["server", "a server bundle"],
  ["client", "the adapter's client/server split (static output has neither)"],
  ["node_modules", "installed packages"],
  ["functions", "Pages Functions"],
  [".vercel", "Vercel build output"],
  ["_worker.js", "an advanced-mode Worker bundle"],
  ["chunks", "server chunks (browser chunks live in _astro/)"],
]);

/** A script that asks for a runtime a browser does not have. */
const SERVER_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](node:[\w/.-]+|cloudflare:[\w/.-]+)["']/;

async function walk(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(base, full).split(sep).join("/");
    if (entry.isDirectory()) {
      out.push({ rel, dir: true });
      await walk(full, base, out);
    } else {
      out.push({ rel, dir: false, full });
    }
  }
  return out;
}

/** The text of a JSONC file with comments removed (strings respected). */
export function stripJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  // Trailing commas, which wrangler's JSONC allows.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** The pages the route table says the build must hold. */
async function migratedAssets(repo) {
  const table = JSON.parse(
    await readFile(join(repo, "workers/web/routing/routes.json"), "utf8"),
  );
  return [
    ...table.routes.filter((r) => r.status === "migrated").map((r) => r.asset),
    ...table.astro_only.map((r) => r.asset),
  ];
}

/**
 * Problems with the build output at `dist` (an empty list means it is static
 * files and nothing else).
 */
export async function checkArtefact(dist, repo = REPO) {
  const problems = [];
  if (!existsSync(dist)) {
    return [`${dist} does not exist: run \`npm run build\` first.`];
  }
  const files = await walk(dist);
  const pages = files.filter((f) => !f.dir && f.rel.endsWith(".html"));
  if (pages.length === 0) problems.push(`${dist} holds no HTML page.`);

  for (const f of files) {
    const name = basename(f.rel);
    if (f.dir) {
      const why = SERVER_DIRS.get(name);
      // `chunks` and `client` only count at the top: `_astro/client.js` is a
      // file, and a folder of that name deeper down is the page's own.
      const top = !f.rel.includes("/");
      if (why && (top || !["chunks", "client"].includes(name))) {
        problems.push(`${f.rel}/: ${why}.`);
      }
      continue;
    }
    const why = SERVER_FILES.get(name);
    if (why) problems.push(`${f.rel}: ${why}.`);
    if (/\.(?:m?js|cjs)$/.test(name)) {
      const text = await readFile(f.full, "utf8");
      const hit = SERVER_IMPORT.exec(text);
      if (hit) {
        problems.push(
          `${f.rel}: imports ${hit[1]}, a server runtime (browser JavaScript only).`,
        );
      }
    }
  }

  for (const asset of await migratedAssets(repo)) {
    if (!files.some((f) => !f.dir && f.rel === asset)) {
      problems.push(
        `${asset}: the route table says this page is served, and the build has no such file.`,
      );
    }
  }
  return problems;
}

const ADAPTER =
  /^(?:@astrojs\/(?:cloudflare|node|vercel|netlify|deno)|@cloudflare\/vite-plugin)$/;

function stripJsComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Problems with the config that decides what gets built and served. */
export async function checkConfig(repo = REPO) {
  const problems = [];
  const read = (p) => readFile(join(repo, p), "utf8");

  const astroConfig = stripJsComments(await read("astro/astro.config.mjs"));
  if (/@astrojs\/(?:cloudflare|node|vercel|netlify|deno)/.test(astroConfig)) {
    problems.push("astro/astro.config.mjs imports a server adapter.");
  }
  if (/\badapter\s*:/.test(astroConfig)) {
    problems.push("astro/astro.config.mjs sets `adapter`.");
  }
  if (!/\boutput\s*:\s*["']static["']/.test(astroConfig)) {
    problems.push('astro/astro.config.mjs must set `output: "static"`.');
  }

  const pkg = JSON.parse(await read("astro/package.json"));
  for (const name of Object.keys({
    ...pkg.dependencies,
    ...pkg.devDependencies,
  })) {
    if (ADAPTER.test(name)) {
      problems.push(`astro/package.json depends on ${name}, a server adapter.`);
    }
  }

  let wrangler;
  try {
    wrangler = JSON.parse(stripJsonc(await read("workers/web/wrangler.jsonc")));
  } catch (e) {
    problems.push(`workers/web/wrangler.jsonc does not parse: ${e.message}`);
  }
  if (wrangler) {
    if (wrangler.main !== "build/index.js") {
      problems.push(
        `workers/web/wrangler.jsonc main is ${JSON.stringify(wrangler.main)}; it must be the Rust build, "build/index.js".`,
      );
    }
    if (!String(wrangler.build?.command ?? "").startsWith("worker-build")) {
      problems.push(
        "workers/web/wrangler.jsonc build.command must be worker-build.",
      );
    }
    const dir = wrangler.assets?.directory;
    if (
      !dir ||
      resolve(repo, "workers/web", dir) !== resolve(repo, "astro/dist")
    ) {
      problems.push(
        "workers/web/wrangler.jsonc assets.directory must be ../../astro/dist.",
      );
    }
    if (wrangler.assets?.run_worker_first !== true) {
      problems.push(
        "workers/web/wrangler.jsonc assets.run_worker_first must be true (the Worker routes everything).",
      );
    }
    if (wrangler.workers_dev !== false) {
      problems.push(
        "workers/web/wrangler.jsonc workers_dev must be false (dark).",
      );
    }
    for (const key of ["routes", "route", "site"]) {
      if (key in wrangler) {
        problems.push(
          `workers/web/wrangler.jsonc sets \`${key}\`: nothing routes here until the owner does it.`,
        );
      }
    }
  }

  // No JavaScript or Node project inside the Rust Worker (its own `build/` is
  // worker-build's output and `target/` is cargo's).
  const webDir = join(repo, "workers/web");
  for (const f of await walk(webDir)) {
    if (f.dir) continue;
    if (/^(?:build|target|node_modules)\//.test(f.rel)) continue;
    if (
      /\.(?:[cm]?[jt]s|[jt]sx)$/.test(f.rel) ||
      basename(f.rel) === "package.json"
    ) {
      problems.push(
        `workers/web/${f.rel}: JavaScript or a Node project inside the Rust Worker.`,
      );
    }
  }
  if (!existsSync(join(webDir, "Cargo.toml"))) {
    problems.push("workers/web/Cargo.toml is missing.");
  }
  return problems;
}

export async function main(argv) {
  const dist = resolve(argv[0] ?? join(REPO, "astro/dist"));
  const problems = [...(await checkConfig()), ...(await checkArtefact(dist))];
  if (problems.length > 0) {
    console.error(
      'The web build must be static files plus the Rust Worker ("Rust serves it, JS only in the browser", #579). Found:\n',
    );
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      "\nNo server bundle, adapter, `_worker.js`, `_headers`/`_redirects` or Node runtime may ship. A page that needs a server prerenders, or Rust renders it.",
    );
    return 1;
  }
  console.log(
    `ok: ${relative(REPO, dist)} is static files only; the Worker is Rust (main build/index.js), assets read through the binding.`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main(process.argv.slice(2)));
}
