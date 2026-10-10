import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The proxy imports AuthKit at module load; only its exported config is used here.
vi.mock("@workos-inc/authkit-nextjs", () => ({
  authkit: vi.fn(),
  handleAuthkitProxy: vi.fn(),
}));
import {
  MISSING_ASSET_DESTINATION,
  MISSING_ASSET_RE,
  MISSING_ASSET_SOURCE,
} from "@/lib/missing-asset";
import { config as proxyConfig } from "@/proxy";
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

  it("next.config wires the shared pattern as an afterFiles rewrite", () => {
    const config = readFileSync(resolve(ROOT, "next.config.ts"), "utf8");
    expect(config).toMatch(/afterFiles:\s*\[/);
    expect(config).toContain("source: MISSING_ASSET_SOURCE");
    expect(config).toContain("destination: MISSING_ASSET_DESTINATION");
    expect(MISSING_ASSET_DESTINATION).toBe("/api/missing-asset");
  });

  it("the rewrite source is a single named segment", () => {
    // Both MISSING_ASSET_SOURCE and MISSING_ASSET_RE are built from one
    // SEGMENT constant, so the cases below exercise what the rewrite matches.
    expect(MISSING_ASSET_SOURCE).toMatch(
      /^\/:file\(\[\^\/\]\*\\\.\[\^\/\]\*\)$/,
    );
  });

  it("catches any dotted top-level file and never a location slug", () => {
    for (const p of [
      "/favicon-48.png",
      "/favicon-180.png",
      "/old.svg",
      "/backup.tar-gz",
      "/index.php~",
      "/favicon.png.",
      "/.env",
    ]) {
      expect(MISSING_ASSET_RE.test(p), p).toBe(true);
    }
    for (const p of [
      "/harare",
      "/nairobi-ke",
      "/west-paddock--ksy4dd7",
      "/canberra-residences--osm-w890123",
      "/harare/map",
    ]) {
      expect(MISSING_ASSET_RE.test(p), p).toBe(false);
    }
  });
});

describe("proxy matcher skips files", () => {
  const matcher = new RegExp(`^${proxyConfig.matcher[0]}$`);
  it("runs on page paths", () => {
    for (const p of [
      "/",
      "/harare",
      "/harare/map",
      "/auth/signin",
      "/profile",
    ]) {
      expect(matcher.test(p), p).toBe(true);
    }
  });
  it("never runs on a file, so a file can't become the lastLocation cookie", () => {
    for (const p of [
      "/favicon.ico",
      "/favicon-32.png",
      "/apple-touch-icon.png",
      "/icon-512.png",
      "/manifest.json",
      "/sw.js",
      "/favicon-48.png",
      "/vendor/maplibre-gl/6.0.0/maplibre-gl-worker.mjs",
      "/icons/icon-192.png",
      "/icons/anything",
      "/_next/static/chunk.js",
    ]) {
      expect(matcher.test(p), p).toBe(false);
    }
  });
});
