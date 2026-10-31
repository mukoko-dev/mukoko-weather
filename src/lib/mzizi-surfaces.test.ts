/**
 * Mzizi surface guard — radius and border rules for CARD surfaces, not just
 * buttons.
 *
 * Why this exists (owner report 2026-10-17, /locations screenshot): the MY
 * LOCATION card had square corners and a thick left-only purple border while
 * its sibling saved cards were rounded with a faint left border. Two root
 * causes, both invisible to mzizi-alignment.test.ts:
 *   1. That test only reads `<button` / `role="button"` tags. Cards are
 *      `div`, `Link` and `section`, so no card was ever inspected.
 *   2. Its radius allow-list trusted the NAMES `rounded-card`,
 *      `rounded-button` and `rounded-badge`, but --radius-card & co. are
 *      :root variables that were never registered in the `@theme` block, so
 *      Tailwind generates nothing for those utilities: the element silently
 *      has no radius. A name on a list is not proof the class exists.
 * The rules below are checked over every TSX/CSS file for any element.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const css = readFileSync(join(ROOT, "src/app/globals.css"), "utf-8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(name) && !name.endsWith(".test.ts"))
      out.push(full);
  }
  return out;
}

const SOURCES = walk(join(ROOT, "src"))
  .filter((f) => !f.includes("/api/og/") && !f.includes("weather-scenes"))
  .map((f) => ({ file: relative(ROOT, f), src: readFileSync(f, "utf-8") }));

/** The `@theme` blocks, where utility-generating variables live. */
const themeBlocks = [...css.matchAll(/@theme[^{]*\{([\s\S]*?)\n\}/g)]
  .map((m) => m[1])
  .join("\n");

describe("radius shorthands must exist before they are used", () => {
  for (const name of ["card", "button", "badge", "input"]) {
    it(`rounded-${name} is only used if --radius-${name} is registered in @theme`, () => {
      const registered = new RegExp(`--radius-${name}\\s*:`).test(themeBlocks);
      if (registered) return;
      const offenders = SOURCES.filter((s) =>
        new RegExp(`\\brounded(-[a-z]{1,2})?-${name}\\b`).test(s.src),
      ).map((s) => s.file);
      const inCss = new RegExp(`@apply[^;]*\\brounded-${name}\\b`).test(css);
      expect({ offenders, inCss }).toEqual({ offenders: [], inCss: false });
    });
  }
});

/** Single-side accent borders are another brand's pattern, not Mzizi's. */
const SIDE_ACCENT =
  /(?<![\w-])(?:[a-z-]+:)*border-[lr](?:-(?!transparent)[\w[\]()/.#-]+)?(?![\w-])/;

/** Files where a side border is structural, not a card accent (with reason). */
const SIDE_BORDER_ALLOWED: Record<string, string> = {
  "src/components/ui/scroll-area.tsx":
    "Radix scrollbar track gutter: border-l/-t with a transparent colour",
};

describe("no single-side accent borders on card surfaces", () => {
  it("no component draws border-l-* / border-r-* (use a full mineral-tinted border)", () => {
    const offenders: string[] = [];
    for (const { file, src } of SOURCES) {
      if (SIDE_BORDER_ALLOWED[file]) continue;
      src.split("\n").forEach((line, i) => {
        if (line.trim().startsWith("*") || line.trim().startsWith("//")) return;
        if (SIDE_ACCENT.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("no component fakes a side stripe with an absolutely-positioned span (owner report 2026-10-31: EdgeTile and RecentReports drew a 4px left rule that border-l tests never saw)", () => {
    const STRIPE =
      /absolute[^"'`]*\binset-y-0\b[^"'`]*\b(?:left|right|start|end)-0\b|absolute[^"'`]*\b(?:left|right|start|end)-0\b[^"'`]*\binset-y-0\b/;
    const offenders: string[] = [];
    for (const { file, src } of SOURCES) {
      src.split("\n").forEach((line, i) => {
        if (line.trim().startsWith("*") || line.trim().startsWith("//")) return;
        if (STRIPE.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("globals.css has no left/right-only border on a card class", () => {
    expect(css).not.toMatch(/border-(left|right)(-width|-color)?\s*:/);
    expect(css).not.toMatch(/@apply[^;]*border-[lr]-/);
  });

  it("CategoryStyle carries no leading-edge accent field", () => {
    const acts = SOURCES.find((s) => s.file === "src/lib/activities.ts")!.src;
    expect(acts).not.toContain("borderAccent");
  });
});

describe("the card edge: one rule, tokens only", () => {
  const edgeList = css.match(
    /--card-border-width: var\(--border-width-rest\);/,
  );
  const listMatch = css.match(
    /:is\(\s*((?:\.[a-z-]+(?:,\s*)?)+)\s*\)\s*\{\s*--card-border-width: var\(--border-width-rest\)/,
  );
  const edgeClasses = listMatch
    ? [...listMatch[1].matchAll(/\.([a-z-]+)/g)].map((m) => m[1])
    : [];

  it("defines 0.5px at rest and 1px active as tokens", () => {
    expect(css).toMatch(/--border-width-rest:\s*0\.5px/);
    expect(css).toMatch(/--border-width-active:\s*1px/);
    expect(edgeList).not.toBeNull();
  });

  it("draws a solid border on all four sides from the token", () => {
    expect(css).toMatch(
      /border-style: solid;\s*border-width: var\(--card-border-width\);/,
    );
  });

  it("goes to the active width on hover, aria state and focus-visible", () => {
    for (const hook of [
      ":hover",
      '[aria-current]:not([aria-current="false"])',
      '[aria-pressed="true"]',
      '[aria-selected="true"]',
      ":focus-visible",
    ]) {
      expect(css).toContain(hook);
    }
    expect(css).toMatch(/--card-border-width: var\(--border-width-active\)/);
  });

  it("keeps borders visible in forced-colors and high-contrast modes", () => {
    const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
    expect(forced).toMatch(/--border-width-rest:\s*1px/);
    const contrast = css.slice(css.indexOf("@media (prefers-contrast: more)"));
    expect(contrast).toMatch(/--border-width-rest:\s*1px/);
  });

  it("every card surface class in globals.css joins the edge list", () => {
    // A card surface = a fauna class that paints a card radius AND a border.
    const blocks = [...css.matchAll(/\n  \.([a-z-]+)\s*\{([^}]*)\}/g)];
    const cards = blocks
      .filter(
        ([, , body]) =>
          /rounded-\[var\(--radius-card\)\]|border-radius:\s*var\(--radius-card\)/.test(
            body,
          ) &&
          /(?<![\w-])border(?![\w-])|(?<![\w-])border-(?!radius)[a-z]/.test(
            body,
          ),
      )
      .map(([, name]) => name)
      // .ledger-style inner dividers etc. are not card surfaces
      .filter((n) => !["guineafowl-heading", "guineafowl-row"].includes(n));
    const missing = cards.filter(
      (n) => !edgeClasses.includes(n) && n !== "bushbuck",
    );
    expect(missing).toEqual([]);
    for (const n of [
      "baobab",
      "acacia",
      "guineafowl-card",
      "chameleon",
      "nyala",
    ]) {
      expect(edgeClasses).toContain(n);
    }
  });

  it("the location tile and place rows use the shared classes, not their own borders", () => {
    const tile = SOURCES.find(
      (s) => s.file === "src/components/weather/LocationWeatherCard.tsx",
    )!.src;
    expect(tile).toContain("nyala");
    expect(tile).not.toMatch(/rounded-card|border-l/);
    const modal = SOURCES.find(
      (s) => s.file === "src/components/weather/MyWeatherModal.tsx",
    )!.src;
    expect(modal).toContain("bushbuck");
  });
});

describe("saved-location surfaces use radius TOKENS only", () => {
  const SURFACES = [
    "src/components/weather/LocationWeatherCard.tsx",
    "src/components/weather/MyWeatherModal.tsx",
    "src/components/weather/LocationPromptCard.tsx",
    "src/components/layout/LocationPager.tsx",
    "src/components/ui/mzizi-bottom-nav.tsx",
    "src/app/locations/LocationsClient.tsx",
    "src/app/locations/LocationsMenu.tsx",
    "src/app/locations/LocationsSearch.tsx",
  ];
  const OK =
    /^rounded(?:-[a-z]{1,2})?-(?:full|none|\[var\(--radius-[a-z-]+\)\])$/;

  it("every rounded-* utility is full, none or a --radius-* token", () => {
    const offenders: string[] = [];
    for (const f of SURFACES) {
      const src = SOURCES.find((s) => s.file === f)!.src.replace(
        /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm,
        "",
      );
      for (const m of src.matchAll(/[\w:-]*\brounded(?:-[\w[\]()-]+)?/g)) {
        const t = m[0].split(":").pop()!;
        if (!t.startsWith("rounded")) continue;
        if (!OK.test(t)) offenders.push(`${f}: ${t}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("menus inside a card use --radius-sm rows (smaller than the container)", () => {
    for (const f of [
      "src/app/locations/LocationsMenu.tsx",
      "src/app/locations/LocationsSearch.tsx",
      "src/components/weather/LocationWeatherCard.tsx",
    ]) {
      const src = SOURCES.find((s) => s.file === f)!.src;
      expect(src, f).not.toMatch(/rounded-\[var\(--radius-button\)\] px-3 py-/);
      expect(src, f).toContain("rounded-[var(--radius-sm)]");
    }
  });
});
