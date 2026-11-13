/**
 * The Python backend is gone (#333): every route is a Rust Worker route and
 * Vercel serves the frontend only. This pins that, so a Python route, a
 * `/api/py` call or a Python CI step cannot come back unnoticed.
 *
 * The one `/api/py` path that remains is the hardware upload URL consoles in
 * the field are configured with (`/api/py/stations/ingest`): `vercel.json`
 * rewrites it to the stations Worker, and that Worker takes it as a route.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Every file under `dir` with an extension in `ext`, skipping build output. */
function walk(
  dir: string,
  ext: RegExp,
  out: string[] = [],
  skip: string[] = [],
): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (
      name === "node_modules" ||
      name === "target" ||
      name.startsWith(".") ||
      skip.includes(name)
    ) {
      continue;
    }
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, ext, out, skip);
    else if (ext.test(name)) out.push(full);
  }
  return out;
}

/** Source with its comments removed (block comments, and whole-line `//`). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The files that may name `/api/py` in non-test code, and why. */
const ALLOWED_NAMES = new Map([
  [
    "src/lib/security-headers.ts",
    "CORS_POLICY.noCors: the legacy hardware upload path",
  ],
  [
    "src/app/api/retired/route.ts",
    "the 404 problem document, which says what was removed",
  ],
  [
    "src/lib/retired-api.ts",
    "the rewrite source that sends every retired /api/py path to a 404",
  ],
]);

describe("no Python backend", () => {
  it("has no api/ directory, no Python tests, no pytest or pip files", () => {
    for (const gone of [
      "api",
      "tests/py",
      "pytest.ini",
      "requirements.txt",
      "tests/__init__.py",
    ]) {
      expect(existsSync(join(ROOT, gone)), gone).toBe(false);
    }
  });

  it("keeps one Python file anywhere: the GEOGLAM table builder, which imports nothing of the backend", () => {
    const python = walk(ROOT, /\.py$/, [], ["public", "coverage"]).map((f) =>
      relative(ROOT, f),
    );
    expect(python).toEqual(["scripts/build_geoglam_calendars.py"]);
    const builder = read("scripts/build_geoglam_calendars.py");
    expect(builder).not.toMatch(/^\s*(from|import)\s+py\b/m);
    expect(builder).not.toMatch(/^\s*(from|import)\s+(fastapi|pymongo)\b/m);
    // It writes the table the Rust crate compiles in.
    expect(builder).toContain("weather-core");
  });

  it("src/ never names /api/py outside the allowed lines", () => {
    const named: string[] = [];
    for (const file of walk(join(ROOT, "src"), /\.(ts|tsx|js|jsx|mjs)$/)) {
      const rel = relative(ROOT, file);
      // Tests assert the paths are gone, so they have to name them.
      if (/\.test\.(ts|tsx)$/.test(rel)) continue;
      const text = readFileSync(file, "utf8");
      if (!text.includes("/api/py")) continue;
      if (!ALLOWED_NAMES.has(rel)) named.push(rel);
    }
    expect(named).toEqual([]);
  });

  it("no source or config outside the stations Worker and vercel.json routes /api/py", () => {
    const places = [
      ...walk(join(ROOT, "src"), /\.(ts|tsx)$/),
      ...walk(join(ROOT, "station-console", "src"), /\.(ts|tsx)$/),
    ].filter(
      (f) =>
        !/\.test\.(ts|tsx)$/.test(f) && !ALLOWED_NAMES.has(relative(ROOT, f)),
    );
    for (const file of places) {
      const text = code(readFileSync(file, "utf8"));
      // A fetch or a URL built from the prefix would be a call site.
      expect(text, relative(ROOT, file)).not.toMatch(
        /(fetch|new URL|workerUrl)\([^)]*\/api\/py/,
      );
      expect(text, relative(ROOT, file)).not.toMatch(/["'`]\/api\/py\//);
    }
    const next = read("next.config.ts");
    expect(next).not.toMatch(/["'`]\/api\/py/);
  });

  it("runs no Python in CI, in npm scripts or in the workflows", () => {
    const pkg = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    expect(Object.keys(pkg.scripts)).not.toContain("test:python");
    expect(Object.keys(pkg.scripts)).not.toContain("test:all");
    for (const [name, command] of Object.entries(pkg.scripts)) {
      expect(command, name).not.toMatch(/pytest|python|pip /);
    }
    const workflows = join(ROOT, ".github", "workflows");
    for (const file of readdirSync(workflows)) {
      const text = readFileSync(join(workflows, file), "utf8");
      expect(text, file).not.toMatch(/setup-python|pytest|pip install|pip3/);
      expect(text, file).not.toMatch(/requirements\.txt|tests\/py/);
    }
  });

  it("vercel.json routes no /api/py/(.*) catch-all and builds no function", () => {
    const vercel = JSON.parse(read("vercel.json")) as Record<string, unknown>;
    // `regions` pins where functions run (vercel-config.test.ts); it builds
    // nothing. Any other key (builds, functions, routes) would.
    expect(Object.keys(vercel).sort()).toEqual(["regions", "rewrites"]);
    expect(JSON.stringify(vercel)).not.toMatch(/\/api\/py\/\(|\/api\/py"/);
  });
});
