import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } from "./route";

const ROOT = resolve(__dirname, "../../../../..");

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

  it("never answers 200, 410, 500 or an HTML page", async () => {
    const res = GET();
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).not.toContain("text/html");
  });

  it("is not force-static: a route with POST cannot be generated statically (it answered 500 once)", () => {
    const source = readFileSync(
      resolve(ROOT, "src/app/api/py/[...path]/route.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /export const dynamic\s*=\s*["']force-static["']/,
    );
    expect(source).toContain("export const POST");
  });

  it("is the only thing under /api/py: no other route file", () => {
    expect(existsSync(resolve(ROOT, "src/app/api/py/[...path]/route.ts"))).toBe(
      true,
    );
    // The upload URL is vercel.json's rewrite, not a route of this app.
    expect(existsSync(resolve(ROOT, "src/app/api/py/stations"))).toBe(false);
    const vercel = JSON.parse(
      readFileSync(resolve(ROOT, "vercel.json"), "utf8"),
    );
    expect(vercel.rewrites).toHaveLength(1);
    expect(vercel.rewrites[0].source).toBe("/api/py/stations/ingest");
  });
});
