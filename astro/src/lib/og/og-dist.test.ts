/**
 * Checks on the BUILT site (dist), so they need `npm run build` first.
 * `npm test` skips them with a note when there is no build; `npm run
 * test:dist` (CI, after the build) requires one and fails without it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOCATIONS } from "@/lib/locations";
import { PAGE_CARDS } from "./pages";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const client = join(root, "dist");
const built = existsSync(join(client, "og/site.png"));
const required = process.env.OG_DIST_REQUIRED === "1";

if (!built && !required) {
  console.warn("og-dist.test: no build in dist, skipped (npm run build first)");
}

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files(path, out);
    else out.push(path);
  }
  return out;
}

const meta = (html: string, attr: "property" | "name", key: string) =>
  html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`))?.[1];

describe.skipIf(!built && !required)("the built site", () => {
  it("has a build to check", () => {
    expect(built).toBe(true);
  });

  it("has a valid 1200x630 PNG for every shipped location, named by its slug", () => {
    for (const loc of LOCATIONS) {
      const file = join(client, "og/locations", `${loc.slug}.png`);
      expect(existsSync(file), `og/locations/${loc.slug}.png`).toBe(true);
      const png = readFileSync(file);
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(png.readUInt32BE(16)).toBe(1200);
      expect(png.readUInt32BE(20)).toBe(630);
      // link previews are fetched under size limits (WhatsApp: ~300 KB)
      expect(png.length).toBeLessThan(150_000);
    }
    expect(readdirSync(join(client, "og/locations"))).toHaveLength(
      LOCATIONS.length,
    );
  });

  it("has the site card and a card for every page that has one", () => {
    expect(existsSync(join(client, "og/site.png"))).toBe(true);
    for (const page of PAGE_CARDS) {
      expect(
        existsSync(join(client, "og/pages", `${page.path.slice(1)}.png`)),
      ).toBe(true);
    }
  });

  const pages = built ? files(client).filter((f) => f.endsWith(".html")) : [];

  it("finds the built pages", () => {
    expect(pages.length).toBeGreaterThanOrEqual(7);
  });

  for (const file of pages) {
    const name = relative(client, file);
    describe(name, () => {
      const html = readFileSync(file, "utf8");

      it("has an absolute og:image and twitter:image that exist in the build", () => {
        const og = meta(html, "property", "og:image");
        const tw = meta(html, "name", "twitter:image");
        expect(og).toMatch(/^https:\/\/weather\.mukoko\.com\/og\/.+\.png$/);
        expect(tw).toBe(og);
        const path = new URL(og!).pathname;
        expect(existsSync(join(client, path)), path).toBe(true);
        expect(statSync(join(client, path)).size).toBeGreaterThan(1000);
      });

      it("describes the card: type, size, alt, large twitter card", () => {
        expect(meta(html, "property", "og:image:type")).toBe("image/png");
        expect(meta(html, "property", "og:image:width")).toBe("1200");
        expect(meta(html, "property", "og:image:height")).toBe("630");
        expect(meta(html, "property", "og:image:alt")?.length).toBeGreaterThan(
          3,
        );
        expect(meta(html, "name", "twitter:image:alt")?.length).toBeGreaterThan(
          3,
        );
        expect(meta(html, "name", "twitter:card")).toBe("summary_large_image");
      });

      it("has og:url equal to its own absolute canonical", () => {
        const canonical = html.match(
          /<link rel="canonical" href="([^"]*)"/,
        )?.[1];
        if (!canonical) {
          expect(meta(html, "property", "og:url")).toBeUndefined();
          return;
        }
        expect(canonical).toMatch(/^https:\/\/weather\.mukoko\.com\/[a-z/-]*$/);
        expect(meta(html, "property", "og:url")).toBe(canonical);
      });
    });
  }

  it("uses each page's own card, and the site card otherwise", () => {
    for (const page of PAGE_CARDS) {
      const html = readFileSync(
        join(client, `${page.path.slice(1)}.html`),
        "utf8",
      );
      expect(meta(html, "property", "og:image")).toBe(
        `https://weather.mukoko.com/og/pages/${page.path.slice(1)}.png`,
      );
    }
    const preview = readFileSync(join(client, "shell-preview.html"), "utf8");
    expect(meta(preview, "property", "og:image")).toBe(
      "https://weather.mukoko.com/og/site.png",
    );
  });

  it("ships no Node module and no build-only library in the browser output", () => {
    const offenders: string[] = [];
    for (const file of files(client)) {
      if (!/\.(m?js|html|json)$/.test(file)) continue;
      const text = readFileSync(file, "utf8");
      if (
        /(?:from|import)\s*\(?\s*["']node:/.test(text) ||
        /require\(\s*["']node:/.test(text) ||
        /(?:from|import)\s*\(?\s*["'](?:sharp|satori)["']/.test(text)
      ) {
        offenders.push(relative(client, file));
      }
    }
    expect(offenders).toEqual([]);
    // and there is no server bundle: every page is a static file
    const server = join(root, "dist/server");
    expect(!existsSync(server) || readdirSync(server).length === 0).toBe(true);
  });
});
