import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RETIRED_API_DESTINATION,
  RETIRED_API_RE,
  RETIRED_API_ROOT,
  RETIRED_API_SOURCE,
} from "@/lib/retired-api";
import { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } from "./route";

const ROOT = resolve(__dirname, "../../../..");

describe("the retired /api/py API", () => {
  it("answers every method with a 404 problem document that says where the API went", async () => {
    for (const handler of [GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS]) {
      const res = handler();
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toBe("application/problem+json");
      const body = await res.json();
      expect(body.status).toBe(404);
      expect(body.title).toBe("Not Found");
      expect(body.detail).toContain("https://weather-api.mukoko.com/v1/");
    }
  });

  it("caches a read for five minutes and never a write", () => {
    for (const handler of [GET, HEAD]) {
      expect(handler().headers.get("Cache-Control")).toBe(
        "public, max-age=300",
      );
    }
    for (const handler of [POST, PUT, PATCH, DELETE, OPTIONS]) {
      expect(handler().headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("never answers 200, 410, 500 or an HTML page", () => {
    const res = GET();
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).not.toContain("text/html");
  });

  it("is not force-static: a route with POST cannot be generated statically (it answered 500 once)", () => {
    const source = readFileSync(
      resolve(ROOT, "src/app/api/retired/route.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /export const dynamic\s*=\s*["']force-static["']/,
    );
    expect(source).toContain("export const POST");
  });
});

describe("the rewrite to it", () => {
  it("is wired in next.config.ts, after files, from the shared constants", () => {
    const config = readFileSync(resolve(ROOT, "next.config.ts"), "utf8");
    expect(config).toContain("source: RETIRED_API_SOURCE");
    expect(config).toContain("source: RETIRED_API_ROOT");
    expect(config.match(/destination: RETIRED_API_DESTINATION/g)).toHaveLength(
      2,
    );
    // afterFiles: a real file or route always wins.
    const after = config.indexOf("afterFiles");
    expect(after).toBeGreaterThan(-1);
    expect(config.indexOf("RETIRED_API_SOURCE", after)).toBeGreaterThan(after);
    expect(RETIRED_API_DESTINATION).toBe("/api/retired");
    expect(RETIRED_API_ROOT).toBe("/api/py");
  });

  it("matches every retired path and NEVER the station upload URL", () => {
    expect(RETIRED_API_SOURCE).toContain("stations/ingest");
    for (const path of [
      "/api/py/health",
      "/api/py/weather",
      "/api/py/ai/followup",
      "/api/py/reports/clarify",
      "/api/py/stations/register",
      "/api/py/stations/manual",
      "/api/py/stations/status",
      "/api/py/stations/ingest/extra",
      "/api/py/stations/ingestx",
      "/api/py/",
    ]) {
      expect(RETIRED_API_RE.test(path), path).toBe(true);
    }
    for (const path of [
      "/api/py/stations/ingest",
      "/api/ai/followup",
      "/api/python/x",
      "/v1/weather",
    ]) {
      expect(RETIRED_API_RE.test(path), path).toBe(false);
    }
  });

  it("leaves no route file of this app under /api/py (the ingest path is the stations Worker's)", () => {
    const vercel = JSON.parse(
      readFileSync(resolve(ROOT, "vercel.json"), "utf8"),
    );
    expect(vercel.rewrites.map((r: { source: string }) => r.source)).toEqual([
      "/api/py/stations/ingest",
    ]);
    expect(existsSync(resolve(ROOT, "src/app/api/py"))).toBe(false);
  });
});
