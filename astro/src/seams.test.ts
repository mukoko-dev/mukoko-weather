import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The rule of #475: no new `next/*` import outside a thin adapter. Components
 * written for Next.js are reused here unchanged; the few modules they import
 * that cannot run here are replaced at build time (astro.config.mjs aliases)
 * by the files in src/shims. These tests keep that list honest: nothing in
 * this app imports `next/*` itself, and the list of replaced modules is
 * exactly the one below. Adding to it is a decision, so it is a test change.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const config = readFileSync(join(root, "astro.config.mjs"), "utf8");

const SEAMS: Record<string, string> = {
  "next/link": "src/shims/next-link.tsx",
  "next/navigation": "src/shims/next-navigation.tsx",
  "@/lib/store": "src/shims/store.ts",
  "@/lib/analytics": "src/shims/analytics.ts",
  "@/components/layout/PhoneMenu": "src/shims/PhoneMenu.tsx",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (["node_modules", "dist", ".astro", ".wrangler"].includes(name))
      return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(astro|tsx?|mjs)$/.test(name) ? [path] : [];
  });
}

describe("the seams between this app and the Next.js app", () => {
  it("replaces exactly the modules listed here, each with a file in src/shims", () => {
    const aliased = [...config.matchAll(/find:\s*\/\^([^$]+)\$\//g)].map((m) =>
      m[1].replaceAll("\\/", "/"),
    );
    expect(aliased.sort()).toEqual(Object.keys(SEAMS).sort());
    for (const file of Object.values(SEAMS)) {
      expect(existsSync(join(root, file)), file).toBe(true);
    }
  });

  it("imports nothing from next/* in this app's own files", () => {
    const offenders = sourceFiles(join(root, "src"))
      .filter((file) => !file.endsWith("seams.test.ts"))
      .filter((file) =>
        /from\s+["']next(\/|["'])/.test(readFileSync(file, "utf8")),
      )
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });

  it("does not add a database client, a database URL or an analytics SDK", () => {
    const banned =
      /(from\s+["'](mongodb|mongoose|pg|@vercel\/analytics|@vercel\/functions)["'])|mongodb(\+srv)?:\/\//;
    const offenders = sourceFiles(join(root, "src"))
      .filter((file) => !file.endsWith("seams.test.ts"))
      .filter((file) => banned.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });
});
