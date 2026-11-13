/**
 * Guard: Google Analytics 4 is the only analytics the app uses (owner,
 * 2026-11-13: "Remove any vercel tracking keep g4").
 *
 * Vercel's hosting stays (`@vercel/functions`, `vercel.json`); what must not
 * come back is its tracking: the Web Analytics and Speed Insights packages, the
 * components that mount them, their script and beacon hosts in the CSP, and a
 * privacy page that says we use them.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { CSP_DIRECTIVES } from "./security-headers";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf-8");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts"))
      out.push(full);
  }
  return out;
}

describe("no Vercel tracking", () => {
  it("depends on neither Vercel tracking package", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(all)).not.toContain("@vercel/analytics");
    expect(Object.keys(all)).not.toContain("@vercel/speed-insights");
    expect(Object.keys(all)).toContain("@vercel/functions"); // hosting stays
  });

  it("imports neither package, loads no Vercel script, and mounts no Vercel component", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(root, "src"))) {
      const text = readFileSync(file, "utf-8");
      if (
        /@vercel\/(analytics|speed-insights)|VercelAnalytics|SpeedInsights|_vercel\/(insights|speed-insights)/.test(
          text,
        )
      )
        offenders.push(file.slice(root.length + 1));
    }
    expect(offenders).toEqual([]);
  });

  it("allows no Vercel script or beacon origin in the CSP", () => {
    const hosts = Object.values(CSP_DIRECTIVES).flat();
    expect(
      hosts.filter((h) => /vercel-scripts|vercel-insights/.test(h)),
    ).toEqual([]);
  });

  it("tells the privacy page's reader the truth: GA4 only", () => {
    const privacy = read("src/app/privacy/page.tsx");
    expect(privacy).not.toMatch(/Vercel (Web )?Analytics/);
    expect(privacy).toContain("any tracking beyond Google Analytics.");
  });
});
