/**
 * Favicon parity with mukoko-news.
 *
 * mukoko-news is the SOURCE OF TRUTH for the Mukoko favicon / app-icon set.
 * Every file below must be a byte-identical copy of the matching file in
 * mukoko-news `public/`. To change an icon, change it in mukoko-news first,
 * then copy the new file here and update its hash. Never edit or regenerate
 * these files in this repo.
 *
 * The test also checks that nothing competes with that set: there must be no
 * app-dir icon files, and the layout metadata and manifest must point only at
 * these paths.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Repo root, resolved from this file so the test works from any cwd.
const ROOT = resolve(__dirname, "../..");

/** sha256 of each file in mukoko-news `public/` (mukoko-news v4.82.0). */
const NEWS_ICON_SHA256: Record<string, string> = {
  "favicon.ico":
    "5c84a6138d3b6ef0dda733e90c85ba1a432ce3d5ac0de4b9d05eaf7cebb2e116",
  "favicon.svg":
    "18661e7ed1e2cef2d1a47ebf869c3bde9bfc9aa65a4d8ea3381d0376c55627a1",
  "favicon-16.png":
    "bf47306ede458717f2aced0f2e8100d31416a4a52d0edcaa7904d30b40c6aa18",
  "favicon-32.png":
    "f7f0e44db9fb572d22178650fbcc4f2c07b3dfdea0fc600f3ed7684112b4a07e",
  "favicon-48.png":
    "73de9583fbdbf5bd8473cab7bf11fc18ff9db3c52e995abbbc6cf167b7d2cb16",
  "favicon-180.png":
    "45913f352bb9814731d8b7673362e772b333b77e6dee8503d92ed885374e1b8a",
  "apple-touch-icon.png":
    "45913f352bb9814731d8b7673362e772b333b77e6dee8503d92ed885374e1b8a",
  "icon-192.png":
    "beb134f9ade8ee34f2a1fd2bd346387b18cf0d2acd4f90b30cf7f7f275d7dc35",
  "icon-512.png":
    "b857b4473ec1f3956a09750c318e71e2d0471e196ab5b29411ce6ec7b35974bc",
  "icon-maskable-192.png":
    "40b532d1816e7603bf11afa3592b2ede1285c69fdf02b60583e4735029d1d36c",
  "icon-maskable-512.png":
    "06bed3502dd0d3d57a99931d8e45024cbe61a43f3dc57aa9d40d19d3398373e3",
};

const sha256 = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

describe("favicon parity with mukoko-news (source of truth)", () => {
  for (const [file, hash] of Object.entries(NEWS_ICON_SHA256)) {
    it(`public/${file} is byte-identical to mukoko-news`, () => {
      expect(sha256(join(ROOT, "public", file))).toBe(hash);
    });
  }

  it("has no competing app-dir icon files", () => {
    // Next.js turns any src/app/{icon,apple-icon}[N].{ext} or favicon.ico
    // into its own <link rel="icon">, which competes with metadata.icons.
    const appDirIcons = readdirSync(join(ROOT, "src", "app")).filter((f) =>
      /^(icon|apple-icon)\d*\.|^favicon\.ico$/.test(f),
    );
    expect(appDirIcons).toEqual([]);
    expect(existsSync(join(ROOT, "public", "favicon-dark.svg"))).toBe(false);
    expect(existsSync(join(ROOT, "public", "icons", "icon.svg"))).toBe(false);
  });

  it("layout metadata declares the news icon set and no hand-written icon links", () => {
    const layout = readFileSync(join(ROOT, "src", "app", "layout.tsx"), "utf8");
    for (const url of [
      "/favicon.svg",
      "/favicon-32.png",
      "/favicon-16.png",
      "/favicon.ico",
      "/apple-touch-icon.png",
    ]) {
      expect(layout).toContain(`url: "${url}"`);
    }
    expect(layout).not.toMatch(/<link\b[^>]*\brel=["'][^"']*icon/);
  });

  it("manifest icons point only at news-set files", () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "public", "manifest.json"), "utf8"),
    ) as { icons: { src: string }[] };
    const srcs = manifest.icons.map((i) => i.src.replace(/^\//, ""));
    expect(srcs).toEqual([
      "favicon.ico",
      "favicon.svg",
      "icon-192.png",
      "icon-512.png",
      "icon-maskable-192.png",
      "icon-maskable-512.png",
    ]);
    for (const s of srcs) expect(NEWS_ICON_SHA256[s]).toBeDefined();
  });
});
