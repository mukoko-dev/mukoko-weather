import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import critical from "./critical.generated.json";

const CRITICAL_CSS = critical.css;
import vocabulary from "./vocabulary.json";
import { makeCritical } from "../../../scripts/critical-css/generate.mjs";

// The inline critical subset of the stylesheet for `/` and the place pages
// (issue #551). It is picked from the stylesheet by names the first screen's
// real DOM has (scripts/critical-css), committed, and put in the head of those
// two pages. Three things must hold: it stays small (it is in the HTML every
// visitor downloads before the first paint), it is what the stylesheet says now
// (a colour changed in globals.css must change the first paint too, not only
// the second), and it holds what the first paint cannot do without.

/**
 * The budget, in bytes. The subset measured 95,288 bytes raw and 17.7 KB
 * gzipped when it was made (647 of the sheet's 1,984 style rules). Raising a
 * number here is a decision to make the HTML of every first visit bigger: say
 * why in the pull request.
 */
const BUDGET = { rawBytes: 102_000, gzipBytes: 19_000 };

describe("the critical subset is small", () => {
  it(`is at most ${BUDGET.rawBytes} bytes, ${BUDGET.gzipBytes} gzipped`, () => {
    expect(Buffer.byteLength(CRITICAL_CSS)).toBeLessThanOrEqual(
      BUDGET.rawBytes,
    );
    expect(gzipSync(CRITICAL_CSS).length).toBeLessThanOrEqual(BUDGET.gzipBytes);
  });

  it("is a real subset: well under the whole stylesheet", async () => {
    const { full } = await makeCritical();
    expect(CRITICAL_CSS.length).toBeLessThan(full.length * 0.6);
  }, 60_000);
});

describe("the critical subset is the stylesheet as it is now", () => {
  it("is what the generator makes of globals.css and the recorded vocabulary", async () => {
    const made = await makeCritical();
    const committed = readFileSync(
      resolve(__dirname, "critical.generated.json"),
      "utf-8",
    );
    // When this fails: `npm run critical-css` and commit the result, with the
    // dependencies the LOCKFILE names (`npm ci`), not whatever is installed: the
    // stylesheet is made by tailwindcss, lightningcss and postcss, and a newer
    // or older one writes different (equivalent, but different) text. If the
    // first screen's markup changed (a new class on it), record the vocabulary
    // again first: `scripts/critical-css/record.mjs`.
    expect(
      committed,
      "critical.generated.json is out of date. A change to globals.css, to the " +
        "first screen's markup, or a bump of tailwindcss, @tailwindcss/postcss, " +
        "lightningcss, postcss or next changes the stylesheet it is made from. " +
        "Run `npm ci && npm run critical-css` (with the lockfile's versions, " +
        "never an older node_modules) and commit critical.generated.json. " +
        "If the first screen's markup changed, run scripts/critical-css/record.mjs first.",
    ).toBe(made.source);
    // and the module says the same CSS the generator made
    expect(CRITICAL_CSS).toBe(made.css);
  }, 60_000);
});

describe("the critical subset holds what the first paint cannot do without", () => {
  it("keeps the layers in the order the whole sheet has them", () => {
    const order = [...CRITICAL_CSS.matchAll(/@layer ([a-z]+)\{/g)].map(
      (m) => m[1],
    );
    expect(order).toEqual([
      "properties",
      "theme",
      "base",
      "components",
      "utilities",
    ]);
  });

  it("has the tokens of both themes, the registered properties and the base rules", () => {
    expect(CRITICAL_CSS).toContain("[data-theme=dark]");
    expect(CRITICAL_CSS).toContain("[data-theme=light]");
    expect(CRITICAL_CSS).toMatch(/:root/);
    expect(CRITICAL_CSS).toContain("@property --tw-");
    expect(CRITICAL_CSS).toMatch(/(^|[^\w-])body\{/);
  });

  it("holds rules for the classes the layout and the hero are drawn with", () => {
    for (const cls of [
      "min-h-screen",
      "bg-background",
      "font-sans",
      "text-foreground",
      "overflow-x-clip",
    ])
      expect(CRITICAL_CSS).toContain(`.${cls}`);
    expect(vocabulary.classes).toContain("bg-background");
  });

  it("holds no rule for a class that is not in the first screen's DOM", () => {
    for (const cls of ["recharts", "leaflet-container", "maplibregl-map"])
      expect(CRITICAL_CSS).not.toContain(`.${cls}`);
  });
});

describe("the critical subset is public, static CSS", () => {
  it("has no import, no font file and no url()", () => {
    expect(CRITICAL_CSS).not.toMatch(/@import/);
    expect(CRITICAL_CSS).not.toMatch(/@font-face/);
    expect(CRITICAL_CSS).not.toMatch(/url\(/);
  });

  it("has nothing about a person: no address, token or id of any kind", () => {
    // (the licence comment names tailwindcss.com; it is not a rule)
    const rules = CRITICAL_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
    expect(rules).not.toMatch(/https?:\/\//);
  });

  it("cannot close the style element it is placed in", () => {
    expect(CRITICAL_CSS.toLowerCase()).not.toContain("</style");
  });
});

describe("the vocabulary is data about the markup, not about anyone", () => {
  it("holds names only: tags, classes, the ids a rule asks about, and attributes", () => {
    expect(vocabulary.tags.length).toBeGreaterThan(10);
    expect(vocabulary.classes.length).toBeGreaterThan(200);
    // an attribute value is kept only where a selector asks for that value
    for (const value of vocabulary.attributes)
      expect(value.length).toBeLessThan(60);
    const text = JSON.stringify(vocabulary);
    expect(text).not.toMatch(/harare|nairobi|lagos|device-/i);
    expect(vocabulary.attributes.some((a) => a.startsWith("class="))).toBe(
      false,
    );
  });
});
