import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVED_ROUTES } from "~/lib/routes";
import {
  DEFAULT_TITLE,
  KEYWORDS,
  OG_IMAGE_URL,
  TWITTER_DESCRIPTION,
} from "~/lib/seo";

/**
 * Route parity (#579, #475): each page this app serves has a Next.js page at
 * the same URL, and the two say the same thing in their head. The Next.js
 * metadata is a TypeScript object and the Astro page's is component props, so
 * the check reads the source of both and compares the strings.
 */
const here = fileURLToPath(new URL(".", import.meta.url));
const read = (path: string) => readFileSync(join(here, path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");

/** The first string literal after `key:` in a Next.js `metadata` object. */
function nextField(source: string, key: "title" | "description"): string {
  const text = flat(source);
  const m = text.match(new RegExp(`${key}: "((?:[^"\\\\]|\\\\.)*)"`));
  if (m) return m[1];
  // `description: DESCRIPTION`, with the constant declared above.
  const named = text.match(new RegExp(`${key}: ([A-Z_]+)`));
  const declared =
    named &&
    text.match(new RegExp(`const ${named[1]} = "((?:[^"\\\\]|\\\\.)*)"`));
  if (!declared) throw new Error(`no ${key} in the Next.js page`);
  return declared[1];
}

function astroProp(source: string, name: string): string {
  const m = flat(source).match(new RegExp(`${name}="([^"]*)"`));
  if (!m) throw new Error(`no ${name} on the Astro page`);
  return m[1].replaceAll("&amp;", "&");
}

const PAGES: Record<string, { next: string; astro: string }> = {
  "/about": {
    next: "../../src/app/about/page.tsx",
    astro: "pages/about.astro",
  },
  "/help": { next: "../../src/app/help/page.tsx", astro: "pages/help.astro" },
  "/privacy": {
    next: "../../src/app/privacy/page.tsx",
    astro: "pages/privacy.astro",
  },
  "/releases": {
    next: "../../src/app/releases/page.tsx",
    astro: "pages/releases.astro",
  },
  "/status": {
    next: "../../src/app/status/page.tsx",
    astro: "pages/status.astro",
  },
  "/terms": {
    next: "../../src/app/terms/page.tsx",
    astro: "pages/terms.astro",
  },
};

describe("route parity with the Next.js pages", () => {
  it("lists a Next.js page for every route served here", () => {
    expect(Object.keys(PAGES).sort()).toEqual([...SERVED_ROUTES].sort());
  });

  for (const [route, files] of Object.entries(PAGES)) {
    describe(route, () => {
      const next = read(files.next);
      const astro = read(files.astro);

      it("has the same title and description", () => {
        expect(astroProp(astro, "title")).toBe(nextField(next, "title"));
        expect(astroProp(astro, "description")).toBe(
          nextField(next, "description"),
        );
      });

      it("has the same canonical path", () => {
        expect(astroProp(astro, "canonicalPath")).toBe(route);
        expect(next).toContain(`\${SITE_URL}${route}\``);
      });
    });
  }
});

describe("the site-wide head matches the Next.js root layout", () => {
  const layout = flat(read("../../src/app/layout.tsx"));

  it("has the same default title, twitter description and keywords", () => {
    expect(layout).toContain(`default: "${DEFAULT_TITLE}"`);
    expect(layout).toContain(`description: "${TWITTER_DESCRIPTION}"`);
    for (const word of KEYWORDS) expect(layout).toContain(`"${word}"`);
  });

  it("builds the card image URL the same way", () => {
    expect(layout).toContain(
      '`${SITE_URL}/api/og?${new URLSearchParams({ title: "mukoko weather", subtitle: "Global Weather Intelligence", template: "home" })}`',
    );
    expect(OG_IMAGE_URL).toBe(
      "https://weather.mukoko.com/api/og?title=mukoko+weather&subtitle=Global+Weather+Intelligence&template=home",
    );
  });
});
