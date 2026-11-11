import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Everything that floats over a page or a map sits on ONE grid (owner,
 * 2026-11-04, from Apple's Find My: the same distance from the screen edge for
 * every control and the same gap between neighbours). The numbers live once,
 * as --float-* tokens in globals.css; the bottom bar, the Quick actions group
 * and the map's controls and sheet read them. This guard fails when one
 * of them grows a number of its own again.
 */
const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const css = read("app/globals.css");
const bottomNav = read("components/ui/mzizi-bottom-nav.tsx");
const map = read("app/[location]/map/MapDashboard.tsx");

/** Strip block comments so a note about the old value is not a use of it. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

describe("the float grid", () => {
  it("is defined once, in globals.css", () => {
    expect(css.match(/--float-inset:/g)).toHaveLength(1);
    expect(css.match(/--float-gap:/g)).toHaveLength(1);
    expect(css.match(/--float-pad:/g)).toHaveLength(1);
    expect(css).toContain("--float-inset: 1rem;");
    expect(css).toContain("--float-gap: 0.5rem;");
    expect(css).toContain("--float-pad: 0.25rem;");
  });

  it("adds the safe area to each edge in one place each", () => {
    expect(css).toContain(
      "--float-top: max(var(--float-inset), env(safe-area-inset-top, 0px));",
    );
    // The bottom edge is the inset plus a small lift (owner, 2026-11-04), so
    // the bar clears the home indicator and the browser's toolbar.
    expect(css).toContain("--float-lift: 0.25rem;");
    expect(css.replace(/\s+/g, " ")).toContain(
      "--float-bottom: calc( env(safe-area-inset-bottom, 0px) + var(--float-inset) + var(--float-lift) );",
    );
    expect(css).toContain(
      "--float-left: max(var(--float-inset), env(safe-area-inset-left, 0px));",
    );
    expect(css).toContain(
      "--float-right: max(var(--float-inset), env(safe-area-inset-right, 0px));",
    );
  });

  it("is what the bottom bar, the Quick actions group and the map read", () => {
    // The page clearance and the bar's position are the same lift: one token.
    expect(css).not.toContain("--mobile-nav-inset");
    expect(css.replace(/\s+/g, " ")).toContain(
      "--mobile-nav-clearance: calc( var(--float-bottom) + var(--mobile-nav-bar-height) + 0.5rem );",
    );
    expect(css).toContain("--hadeda-gap: var(--float-gap);");
    expect(css).toContain("--hadeda-pad: var(--float-pad);");
    expect(code(bottomNav)).toContain("left-[var(--float-left)]");
    expect(code(bottomNav)).toContain("right-[var(--float-right)]");
    expect(code(bottomNav)).toContain("bottom-[var(--float-bottom)]");
    for (const token of [
      "left-[var(--float-left)]",
      "right-[var(--float-right)]",
      "top-[var(--float-top)]",
      "bottom-[var(--float-bottom)]",
    ]) {
      expect(map).toContain(token);
    }
  });

  it("leaves no edge distance or safe-area expression of its own on the map or the bar", () => {
    // The distances this grid replaced: left-4/right-4, inset-x-3, 0.75rem
    // from the bottom, a max(1rem, env(...)) of their own, and the same written
    // as an arbitrary value (left-[1rem], inset-x-[12px], bottom-[calc(...)]).
    for (const source of [code(map), code(bottomNav)]) {
      expect(source).not.toMatch(
        /(^|[\s"`])-?(left|right|top|bottom|inset|inset-x|inset-y)-[0-9]+(?![/\d.])/,
      );
      expect(source).not.toMatch(
        /(^|[\s"`])(left|right|top|bottom|inset|inset-x|inset-y)-\[(?!var\(--(float|inset-floor|gap-floor|hadeda-below))/,
      );
      expect(source).not.toMatch(/safe-area-inset/);
      expect(source).not.toContain("0.75rem");
      expect(source).not.toMatch(/max\(1rem/);
    }
  });

  it("makes the map's control capsule as wide as a round control beside it, and lets its focus ring show", () => {
    // Find My: the capsule and the lone round control share one width. The
    // capsule has no padding of its own around its two 48px controls, and no
    // overflow clip: its buttons are full circles inside it, and a clip would
    // cut the keyboard focus ring drawn outside them.
    const capsule = map.match(
      /className="(serval pointer-events-auto[^"]*flex-col[^"]*)"/,
    );
    expect(capsule).not.toBeNull();
    expect(capsule?.[1]).toContain("rounded-full");
    expect(capsule?.[1]).not.toMatch(/(^|\s)p[xy]?-/);
    expect(capsule?.[1]).not.toMatch(/overflow-/);
    // Its two controls are a gap apart (the Bundu floor: 7px between adjacent
    // controls), the hairline between them sitting in that gap.
    expect(capsule?.[1]).toContain("gap-[var(--float-gap)]");
  });

  it("keeps its round controls round on keyboard focus (the global ring would square them)", () => {
    const at = css.indexOf(".duiker:focus-visible,");
    expect(at).toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf("}", at));
    for (const selector of [
      ".duiker:focus-visible",
      ".duiker-solid:focus-visible",
      ".plover:focus-visible",
    ]) {
      expect(rule).toContain(selector);
    }
    expect(rule).toContain("border-radius: var(--radius-full);");
  });
});
