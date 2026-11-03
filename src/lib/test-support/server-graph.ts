/**
 * Test support: the server-side import graph of a page.
 *
 * "The page awaits no weather" is a statement about every module the page's
 * server render can reach, not only the page file, so the guards walk the
 * imports. Client modules (`"use client"`) are skipped: their code runs in the
 * browser, in effects, which is where the weather belongs.
 *
 * Not production code; imported by tests only.
 */
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";

/** `src/`, whatever the working directory. */
export const SRC = resolve(__dirname, "../..");

/** Resolve an import specifier to a source file under `src/`, or null. */
export function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? resolve(SRC, spec.slice(2))
    : spec.startsWith(".")
      ? resolve(dirname(from), spec)
      : null;
  if (!base) return null;
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const file = base + ext;
    if (existsSync(file) && /\.(ts|tsx)$/.test(file)) return file;
  }
  return null;
}

/** The value imports of a file (type-only imports are erased and skipped). */
export function importsOf(file: string): { names: string[]; spec: string }[] {
  const text = readFileSync(file, "utf-8");
  const out: { names: string[]; spec: string }[] = [];
  const re = /import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (const m of text.matchAll(re)) {
    if (m[1]) continue;
    const names = [...m[2].matchAll(/([A-Za-z_$][\w$]*)(?:\s+as\s+[\w$]+)?/g)]
      .map((n) => n[1])
      .filter((n) => n !== "type" && n !== "as");
    out.push({ names, spec: m[3] });
  }
  return out;
}

export function isClientModule(file: string): boolean {
  return /^\s*["']use client["']/.test(readFileSync(file, "utf-8"));
}

/** The server modules reachable from `entries` (paths relative to `src/`). */
export function serverGraph(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = entries.map((e) => resolve(SRC, e));
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    if (isClientModule(file)) continue;
    seen.add(file);
    for (const { spec } of importsOf(file)) {
      const target = resolveImport(file, spec);
      if (target) queue.push(target);
    }
  }
  return [...seen];
}

/** A graph file as the name the tests print (relative to `src/`). */
export function relativeToSrc(file: string): string {
  return file.slice(SRC.length + 1);
}
