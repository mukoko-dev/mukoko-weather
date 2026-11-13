/**
 * What the home page's first screen imports statically (issue 551).
 *
 * Everything a first-load chunk imports is downloaded, parsed and run before
 * the weather can show, on a phone that parses JavaScript four times slower
 * than a laptop. This walks the static import graph of the entry points the
 * home page and the place pages hydrate with and fails when a library that
 * belongs behind a tap, a scroll or an idle moment is reachable from it. A
 * dynamic `import()` (React.lazy) is not followed: that is how a heavy part
 * is kept off the first screen.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "..");

/** Files whose imports hydrate with the first screen. */
const ENTRIES = [
  "app/layout.tsx",
  "app/CurrentLocationHome.tsx",
  "app/[location]/WeatherDashboard.tsx",
];

/**
 * Libraries that must stay behind a lazy boundary, with the reason. Add one
 * when a part of the app is moved off the first screen, so it cannot drift back.
 */
const LAZY_ONLY: Record<string, string> = {
  "chart.js": "charts load when a chart section or detail sheet opens",
  "react-chartjs-2": "charts load when a chart section or detail sheet opens",
  "maplibre-gl": "the map loads when its preview is near the viewport",
  leaflet: "the map loads when its preview is near the viewport",
  "react-leaflet": "the map loads when its preview is near the viewport",
  three: "the animated sky loads after the weather has painted",
  "react-markdown": "the AI summary loads when its section is near",
  "@react-pdf/renderer": "PDF export loads when it is asked for",
};

const SPECIFIER =
  /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;

/** Static `import ... from` and `export ... from` targets of a file. */
function staticImports(source: string): { spec: string; names: string }[] {
  const out: { spec: string; names: string }[] = [];
  for (const m of source.matchAll(SPECIFIER)) {
    if (m[2]) continue; // import type / export type
    const names = m[3] ?? "";
    // `import { type A, type B }`: no value comes in, so nothing is bundled.
    const inner = names.match(/^\{([^}]*)\}$/)?.[1];
    if (
      inner !== undefined &&
      inner
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean)
        .every((n) => n.startsWith("type "))
    ) {
      continue;
    }
    out.push({ spec: m[4] ?? m[5], names });
  }
  return out;
}

function resolveLocal(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && /\.(ts|tsx)$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Every package (and named import of it) the entries reach statically, with
 *  the first file that imports it. */
function reachablePackages(): Map<string, { file: string; names: string }> {
  const seen = new Set<string>();
  const packages = new Map<string, { file: string; names: string }>();
  const queue = ENTRIES.map((e) => join(SRC, e));
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { spec, names } of staticImports(readFileSync(file, "utf-8"))) {
      const local = resolveLocal(file, spec);
      if (local) {
        queue.push(local);
        continue;
      }
      if (spec.startsWith(".") || spec.startsWith("@/")) continue;
      const pkg = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0];
      const key = `${pkg}${names ? ` ${names}` : ""}`;
      if (!packages.has(key)) packages.set(key, { file, names });
    }
  }
  return packages;
}

describe("the first screen's static imports", () => {
  const packages = reachablePackages();
  const names = [...packages.keys()];

  it("walks the real app, not a handful of files", () => {
    expect(names.some((n) => n.startsWith("react "))).toBe(true);
    expect(names.some((n) => n.startsWith("zustand"))).toBe(true);
    expect(names.some((n) => n.startsWith("@dnd-kit/core"))).toBe(true);
  });

  for (const [pkg, why] of Object.entries(LAZY_ONLY)) {
    it(`does not reach ${pkg} (${why})`, () => {
      const hit = names.filter((n) => n === pkg || n.startsWith(`${pkg} `));
      expect(
        hit.map((n) => `${n} <- ${packages.get(n)?.file.replace(SRC, "src")}`),
      ).toEqual([]);
    });
  }

  it("does not import the whole lucide library (`icons`)", () => {
    const hit = names.filter(
      (n) => n.startsWith("lucide-react") && /\bicons\b/.test(n),
    );
    expect(hit).toEqual([]);
  });
});
