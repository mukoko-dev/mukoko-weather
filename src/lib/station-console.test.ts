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

  it("defaults to the stations Worker's custom domain", () => {
    expect(api).toContain('"https://weather-ingest.nyuchi.com"');
    expect(api).not.toMatch(/\?\?\s*"https:\/\/weather\.mukoko\.com"/);
  });

  it("keeps the /api/py/stations paths the Worker serves on every host", () => {
    for (const route of ["register", "status", "manual"]) {
      expect(api).toContain(`/api/py/stations/${route}`);
    }
  });

  it("shows a refusal from the Worker's error_description, and still a legacy detail", () => {
    expect(api).toContain("error_description");
    expect(api).toContain("detail");
  });

  it("tells a new station where to upload from the registration answer, not from a constant", () => {
    expect(screen).toContain("creds.ingest.wunderground.server");
    expect(screen).toContain("creds.ingest.ecowitt.path");
    expect(screen).not.toContain(
      '<code className="font-mono">weather.mukoko.com</code>',
    );
  });
});

describe("stations Worker", () => {
  const worker = read("workers/stations/src/lib.rs");

  it("tells new registrations the unprefixed ingest path and still serves the old prefix", () => {
    expect(worker.match(/"path": "\/stations\/ingest"/g)).toHaveLength(2);
    expect(worker).not.toContain('"path": "/api/py/stations/ingest"');
    expect(worker).toContain('strip_prefix("/api/py")');
  });
});

describe("the Python stations route is gone", () => {
  it("has no module, no router and no test", () => {
    expect(existsSync(resolve(ROOT, "api/py/_stations.py"))).toBe(false);
    expect(existsSync(resolve(ROOT, "tests/py/test_stations.py"))).toBe(false);
    expect(read("api/py/index.py")).not.toMatch(/stations/);
  });

  it("is reached only through the Worker: the old ingest URL is rewritten, nothing else under /api/py/stations falls to Python", () => {
    const rewrites = (
      JSON.parse(read("vercel.json")) as {
        rewrites: { source: string; destination: string }[];
      }
    ).rewrites;
    expect(rewrites[0]).toEqual({
      source: "/api/py/stations/ingest",
      destination: "https://weather-ingest.nyuchi.com/api/py/stations/ingest",
    });
  });
});
