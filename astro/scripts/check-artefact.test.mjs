// The gate fails on each way a JavaScript server could come back, and passes
// on a static build. Fixtures are built in a temp folder.
import { mkdir, mkdtemp, rm, writeFile, readFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkArtefact, checkConfig, stripJsonc } from "./check-artefact.mjs";

const REAL_REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const made = [];

async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "artefact-"));
  made.push(dir);
  return dir;
}
afterEach(async () => {
  while (made.length) await rm(made.pop(), { recursive: true, force: true });
});

async function put(root, rel, text = "x") {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), text);
}

/** A repo with just the files the gate reads, copied from the real one. */
async function fakeRepo() {
  const repo = await temp();
  for (const f of [
    "astro/astro.config.mjs",
    "astro/package.json",
    "workers/web/wrangler.jsonc",
    "workers/web/Cargo.toml",
    "workers/web/routing/routes.json",
  ]) {
    await mkdir(dirname(join(repo, f)), { recursive: true });
    await cp(join(REAL_REPO, f), join(repo, f));
  }
  return repo;
}

async function goodDist(repo) {
  const dist = join(repo, "astro/dist");
  // Every page the route table says is served, so this fixture follows the
  // table as pages move over instead of naming them here.
  const table = JSON.parse(
    await readFile(join(repo, "workers/web/routing/routes.json"), "utf8"),
  );
  for (const route of table.routes) {
    if (route.status === "migrated") {
      await put(dist, route.asset, "<html></html>");
    }
  }
  await put(dist, "shell-preview.html", "<html></html>");
  await put(dist, "_astro/client.abc.js", 'import "./react.def.js";');
  return dist;
}

describe("build output", () => {
  it("passes for static files", async () => {
    const repo = await fakeRepo();
    expect(await checkArtefact(await goodDist(repo), repo)).toEqual([]);
  });

  it.each([
    ["_worker.js", "_worker.js/index.js"],
    ["server dir", "server/entry.mjs"],
    ["adapter client dir", "client/about.html"],
    ["adapter config", "wrangler.json"],
    ["_headers", "_headers"],
    ["_redirects", "_redirects"],
    ["routes config", "_routes.json"],
    ["functions", "functions/api.js"],
    ["package.json", "package.json"],
    ["server chunks", "chunks/page.mjs"],
  ])("fails on %s", async (_name, rel) => {
    const repo = await fakeRepo();
    const dist = await goodDist(repo);
    await put(dist, rel);
    const problems = await checkArtefact(dist, repo);
    expect(problems.length).toBeGreaterThan(0);
  });

  it.each([
    'import fs from "node:fs";',
    'const x = require("node:path");',
    'import("cloudflare:workers")',
  ])("fails on a script that imports a server runtime: %s", async (code) => {
    const repo = await fakeRepo();
    const dist = await goodDist(repo);
    await put(dist, "_astro/bad.js", code);
    const problems = await checkArtefact(dist, repo);
    expect(problems.join("\n")).toMatch(/server runtime/);
  });

  it("allows a browser chunk that is merely named client", async () => {
    const repo = await fakeRepo();
    const dist = await goodDist(repo);
    await put(dist, "_astro/client.OzTcoKK0.js", "export const a = 1;");
    expect(await checkArtefact(dist, repo)).toEqual([]);
  });

  it("fails when a migrated page is not in the build", async () => {
    const repo = await fakeRepo();
    const dist = await goodDist(repo);
    await rm(join(dist, "about.html"));
    expect((await checkArtefact(dist, repo)).join("\n")).toMatch(/about\.html/);
  });

  it("fails with a clear message when there is no build", async () => {
    const repo = await fakeRepo();
    const problems = await checkArtefact(join(repo, "nope"), repo);
    expect(problems[0]).toMatch(/npm run build/);
  });
});

describe("config", () => {
  it("passes on the real repo", async () => {
    expect(await checkConfig(REAL_REPO)).toEqual([]);
  });

  async function edit(repo, rel, fn) {
    const p = join(repo, rel);
    await writeFile(p, fn(await readFile(p, "utf8")));
  }

  it("fails when an adapter comes back", async () => {
    const repo = await fakeRepo();
    await edit(repo, "astro/astro.config.mjs", (t) =>
      t.replace(
        'output: "static",',
        'output: "server", adapter: cloudflare(),',
      ),
    );
    const problems = (await checkConfig(repo)).join("\n");
    expect(problems).toMatch(/adapter/);
    expect(problems).toMatch(/static/);
  });

  it("fails when astro depends on an adapter package", async () => {
    const repo = await fakeRepo();
    await edit(repo, "astro/package.json", (t) =>
      t.replace('"dependencies": {', '"dependencies": {"@astrojs/node": "1",'),
    );
    expect((await checkConfig(repo)).join("\n")).toMatch(/@astrojs\/node/);
  });

  it.each([
    ['"main": "build/index.js"', '"main": "src/index.ts"', /build\/index\.js/],
    [
      '"run_worker_first": true',
      '"run_worker_first": false',
      /run_worker_first/,
    ],
    ['"workers_dev": false', '"workers_dev": true', /workers_dev/],
    ['"vars": {', '"routes": [{"pattern":"x"}], "vars": {', /routes/],
  ])("fails when wrangler.jsonc changes %s", async (from, to, re) => {
    const repo = await fakeRepo();
    await edit(repo, "workers/web/wrangler.jsonc", (t) => {
      expect(t).toContain(from);
      return t.replace(from, to);
    });
    expect((await checkConfig(repo)).join("\n")).toMatch(re);
  });

  it("fails on JavaScript inside the Rust Worker", async () => {
    const repo = await fakeRepo();
    await put(repo, "workers/web/src/index.js", "export default {}");
    await put(repo, "workers/web/package.json", "{}");
    const problems = (await checkConfig(repo)).join("\n");
    expect(problems).toMatch(/index\.js/);
    expect(problems).toMatch(/package\.json/);
  });

  it("ignores worker-build's own output folder", async () => {
    const repo = await fakeRepo();
    await put(repo, "workers/web/build/index.js", "export default {}");
    expect(await checkConfig(repo)).toEqual([]);
  });
});

describe("stripJsonc", () => {
  it("keeps URLs in strings and drops comments and trailing commas", () => {
    const out = JSON.parse(
      stripJsonc('{ // c\n "a": "https://x.y/z", /* b */ "b": [1,],\n}'),
    );
    expect(out).toEqual({ a: "https://x.y/z", b: [1] });
  });
});
