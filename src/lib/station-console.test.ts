/**
 * The station console (`station-console/`, its own Vercel project) talks to the
 * Rust stations Worker, not to Python: the facts that keep it so, pinned.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf-8");

describe("station console client", () => {
  const api = read("station-console/src/lib/api.ts");
  const screen = read("station-console/src/components/Console.tsx");

  it("defaults to the stations Worker's existing host, and says it is transitional", () => {
    expect(api).toContain('"https://weather-ingest.nyuchi.com"');
    expect(api).not.toMatch(/\?\?\s*"https:\/\/weather\.mukoko\.com"/);
    expect(api).toContain("TRANSITIONAL");
  });

  it("calls the Worker's own /stations/* paths, never the Python prefix", () => {
    for (const route of ["register", "status", "manual"]) {
      expect(api).toContain("${API_BASE}/stations/" + route);
    }
    expect(api).not.toMatch(/fetch\(`\$\{API_BASE\}\/api\/py/);
    expect(api).not.toContain("detail");
  });

  it("shows a refusal from the Worker's error_description", () => {
    expect(api).toContain("error_description");
  });

  it("tells a new station where to upload from the registration answer, not from a constant", () => {
    expect(screen).toContain("creds.ingest.wunderground.server");
    expect(screen).toContain("creds.ingest.ecowitt.path");
    expect(screen).not.toContain(
      '<code className="font-mono">weather.mukoko.com</code>',
    );
  });
});

describe("the Python stations route is gone", () => {
  it("has no module, no router and no test: the whole Python backend is gone", () => {
    expect(existsSync(resolve(ROOT, "api"))).toBe(false);
    expect(existsSync(resolve(ROOT, "tests/py"))).toBe(false);
  });

  it("serves station uploads from the stations Worker's one host", () => {
    // Ingest is the Worker's (Wunderground GET, Ecowitt POST, the literal
    // body `success`); the one /api/py/stations path consoles in the field
    // use is rewritten to it (vercel.json), the rest is a plain 404.
    const worker = read("workers/stations/src/lib.rs");
    expect(worker).toContain('"/stations/ingest"');
    expect(worker).toContain('strip_prefix("/api/py")');
    expect(worker).toContain('"success"');
  });
});
