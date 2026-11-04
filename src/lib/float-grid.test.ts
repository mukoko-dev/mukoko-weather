import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Everything that floats over a page or a map sits on ONE grid (owner,
 * 2026-11-04, from Apple's Find My: the same distance from the screen edge for
 * every control and the same gap between neighbours). The numbers live once,
 * as --float-* tokens in globals.css; the bottom bar, the phone hero's icon
 * group and the map's controls and sheet read them. This guard fails when one
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

  it("adds the safe area to the top and the bottom in one place each", () => {
    expect(css).toContain(
      "--float-top: max(var(--float-inset), env(safe-area-inset-top, 0px));",
    );
    expect(css).toContain(
      "--float-bottom: calc(env(safe-area-inset-bottom, 0px) + var(--float-inset));",
    );
  });

  it("is what the bottom bar, the hero's icon group and the map read", () => {
    expect(css).toContain("--mobile-nav-inset: var(--float-inset);");
    expect(css).toContain("--hadeda-inset: var(--float-inset);");
    expect(css).toContain("--hadeda-gap: var(--float-gap);");
    expect(css).toContain("--hadeda-pad: var(--float-pad);");
    expect(code(bottomNav)).toContain("inset-x-[var(--float-inset)]");
    expect(code(bottomNav)).toContain("bottom-[var(--float-bottom)]");
    for (const token of [
      "left-[var(--float-inset)]",
      "right-[var(--float-inset)]",
      "top-[var(--float-top)]",
      "inset-x-[var(--float-inset)]",
      "bottom-[var(--float-bottom)]",
    ]) {
      expect(map).toContain(token);
    }
  });

  it("leaves no edge distance of its own on the map or the bar", () => {
    // The distances this grid replaced: left-4/right-4, inset-x-3, 0.75rem
    // from the bottom, and a max(1rem, env(...)) of their own.
    for (const source of [code(map), code(bottomNav)]) {
      expect(source).not.toMatch(/(^|[\s"`])(left|right|inset-x)-[0-9]/);
      expect(source).not.toMatch(/safe-area-inset/);
      expect(source).not.toContain("0.75rem");
      expect(source).not.toMatch(/max\(1rem/);
    }
  });

  it("makes the map's control capsule as wide as a round control beside it", () => {
    // Find My: the capsule and the lone round control share one width. The
    // capsule has no padding of its own around its two 48px controls.
    const capsule = map.match(
      /className="(serval pointer-events-auto flex flex-col overflow-hidden[^"]*)"/,
    );
    expect(capsule).not.toBeNull();
    expect(capsule?.[1]).toContain("rounded-full");
    expect(capsule?.[1]).not.toMatch(/(^|\s)p[xy]?-/);
  });
});
