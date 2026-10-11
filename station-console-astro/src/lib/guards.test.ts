import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const srcDir = join(root, "src");

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

const all = files(srcDir);
const mine = all.filter(
  (f) =>
    !f.includes("/components/mzizi/") &&
    !f.includes("/styles/mzizi-globals.css") &&
    !f.endsWith(".test.ts"),
);
const text = (f: string) => readFileSync(f, "utf8");
const rel = (f: string) => relative(root, f);

describe("data egress (no database in the front end)", () => {
  const forbidden =
    /\b(mongodb|mongoose|pymongo|@cloudflare\/d1|drizzle|prisma|pg|postgres|supabase)\b/i;

  it("declares no database driver", () => {
    const pkg = JSON.parse(text(join(root, "package.json"))) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    for (const name of Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
    }))
      expect(name).not.toMatch(forbidden);
  });
  it("imports no driver and binds no D1/KV/R2 for station records", () => {
    for (const f of mine.filter((x) => /\.(ts|astro)$/.test(x))) {
      const src = text(f);
      expect(src, rel(f)).not.toMatch(
        /from ["'](mongodb|mongoose|pg|postgres|@supabase\/[a-z-]+)["']/,
      );
      expect(src, rel(f)).not.toMatch(/\benv\.(DB|D1|STATIONS_DB)\b/);
    }
    const wrangler = text(join(root, "wrangler.jsonc"));
    expect(wrangler).not.toMatch(
      /d1_databases|kv_namespaces|r2_buckets|hyperdrive/,
    );
  });
  it("only the BFF client modules reach the network, and only the Nyuchi API", () => {
    const fetchers = mine
      .filter((f) => /\bfetch\b/.test(text(f)))
      .map(rel)
      .sort();
    expect(fetchers).toEqual(
      [
        "src/lib/config.ts",
        "src/lib/stations/api-client.ts",
        "src/lib/stations/nyuchi-client.ts",
      ].sort(),
    );
    for (const f of mine) {
      if (!/browser|console|api-client|\.astro$/.test(f) && !/scripts/.test(f))
        continue;
      expect(text(f), rel(f)).not.toMatch(
        /weather-ingest|\/api\/py\/stations\/(register|status|manual)/,
      );
    }
  });
  it("the browser code calls same-origin /api/stations only", () => {
    const calls = [
      ...text(join(srcDir, "lib/stations/api-client.ts")).matchAll(
        /["'`](\/?[a-z]+:\/\/[^"'`]+|\/api[^"'`]*)["'`]/g,
      ),
    ].map((m) => m[1]!);
    for (const c of calls) expect(c).toMatch(/^\/api\/stations/);
  });
});

describe("Mzizi styling rules", () => {
  it("has no hardcoded hex colours or inline styles outside the vendored Mzizi files", () => {
    for (const f of mine.filter((x) => /\.(ts|astro|css)$/.test(x))) {
      const src = text(f);
      expect(src, rel(f)).not.toMatch(
        /(?<![\w/])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b(?![\w-])/,
      );
      expect(src, rel(f)).not.toMatch(/\brgba?\(/);
      expect(src, rel(f)).not.toMatch(/\sstyle\s*=/);
    }
  });
  it("renders every control through Mzizi components (no raw button/input in pages)", () => {
    for (const f of mine.filter(
      (x) => /\/(pages|components|layouts)\//.test(x) && x.endsWith(".astro"),
    )) {
      expect(text(f), rel(f)).not.toMatch(/<button\b/);
      expect(text(f), rel(f)).not.toMatch(/<input\b/);
    }
  });
  it("keeps the seven-mineral ribbon vertical, fixed to the left edge, in the base layout", () => {
    expect(text(join(srcDir, "layouts/Base.astro"))).toContain(
      "site-mineral-strip.astro",
    );
    const strip = text(
      join(srcDir, "components/mzizi/site-mineral-strip.astro"),
    );
    expect(strip).toMatch(/position:\s*fixed/);
    expect(strip).toMatch(/left:\s*0/);
    expect(strip).toMatch(/height:\s*100dvh/);
    expect(strip).toMatch(/flex-direction:\s*column/);
    expect(strip).not.toMatch(/flex-direction:\s*row/);
  });
  it("uses class-based dark mode and the weather brand", () => {
    const base = text(join(srcDir, "layouts/Base.astro"));
    expect(base).toContain('data-brand="weather"');
    expect(base).toContain('classList.toggle("dark"');
  });
});

describe("accessibility and privacy contracts", () => {
  it("has a skip link, noindex, and landmarks on both entry states", () => {
    const base = text(join(srcDir, "layouts/Base.astro"));
    expect(base).toContain('href="#main"');
    expect(base).toContain("noindex");
    const landing = text(join(srcDir, "components/Landing.astro"));
    expect(landing).toContain('role="banner"');
    expect(landing).toContain('id="main"');
    expect(text(join(srcDir, "components/SiteFooter.astro"))).toContain(
      'role="contentinfo"',
    );
  });
  it("renders dynamic text with textContent, never innerHTML", () => {
    expect(text(join(srcDir, "scripts/console.ts"))).not.toMatch(
      /innerHTML|insertAdjacentHTML|outerHTML/,
    );
  });
  it("never logs request data, keys or tokens", () => {
    for (const f of mine.filter((x) => /\.(ts|astro)$/.test(x)))
      expect(text(f), rel(f)).not.toMatch(
        /console\.(log|info|debug|warn|error)\(/,
      );
  });
  it("respects reduced motion (no custom animation defined locally)", () => {
    const css = text(join(srcDir, "styles/global.css"));
    expect(css).not.toMatch(/@keyframes|animation:/);
  });
});
