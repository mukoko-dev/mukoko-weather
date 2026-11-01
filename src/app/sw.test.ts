/**
 * The service worker's routes for the Worker's `/v1` data: what may be cached
 * and what may not. The source is read as text, as the other worker config tests
 * do, because the module registers listeners when it is imported.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "sw.ts"), "utf-8");

/** The runtimeCaching entry whose matcher mentions `needle`. */
function entry(needle: string): string {
  const at = source.indexOf(needle);
  expect(at, `${needle} has a route`).toBeGreaterThan(-1);
  const start = source.lastIndexOf("    {\n", at);
  const end = source.indexOf("\n    },", at);
  return source.slice(start, end);
}

describe("service worker routes for the Worker's data", () => {
  it("never caches /v1/history: a degraded no-store answer must not be served again after Retry", () => {
    const route = entry('startsWith("/v1/history")');
    expect(route).toContain("new NetworkOnly()");
    expect(route).not.toContain("NetworkFirst");
    expect(route).not.toContain("cacheName");
    expect(source).not.toContain('cacheName: "history-data"');
  });

  it("does not leave a Python history path in the service worker", () => {
    expect(source).not.toContain("/api/py/history");
  });

  it("still serves the report list from the network first (GET only)", () => {
    const route = entry('startsWith("/v1/reports")');
    expect(route).toContain('request.method === "GET"');
    expect(route).toContain("new NetworkFirst");
    // The writes (submit, upvote) are POSTs and never matched.
    expect(route).not.toContain('"POST"');
  });
});
