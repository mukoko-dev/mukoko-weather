import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GET, HEAD } from "./route";

const ROOT = resolve(__dirname, "../../../..");

describe("missing-asset 404 handler", () => {
  it("returns a real 404 for GET and HEAD", async () => {
    for (const handler of [GET, HEAD]) {
      const res = handler();
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toContain("text/plain");
      expect(await res.text()).toBe("Not Found");
    }
  });

  it("is wired as an afterFiles rewrite for single-segment dotted paths", () => {
    const config = readFileSync(resolve(ROOT, "next.config.ts"), "utf8");
    expect(config).toMatch(/afterFiles:\s*\[/);
    expect(config).toContain('destination: "/api/missing-asset"');
  });

  it("never matches a location slug (slugs have no dot)", () => {
    // Same pattern as the rewrite source, anchored like path-to-regexp does.
    const re = /^\/([^/]*\.[A-Za-z0-9]+)$/;
    for (const p of ["/favicon-48.png", "/favicon-180.png", "/old.svg"]) {
      expect(re.test(p)).toBe(true);
    }
    for (const p of [
      "/harare",
      "/nairobi-ke",
      "/west-paddock--ksy4dd7",
      "/harare/map",
    ]) {
      expect(re.test(p)).toBe(false);
    }
  });
});
