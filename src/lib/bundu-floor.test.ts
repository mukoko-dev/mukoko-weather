import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Bundu floor (Mzizi registry 4.23.0 and 4.24.0; owner rulings of 1 to 4
 * November 2026; https://docs.mzizi.dev/foundations/bundu-floor and
 * /foundations/spacing-floor; issue #479): a 49px hit region on every control,
 * 14px between text and its container edge (the inline axis for a control),
 * 7px between adjacent controls, and a 3:1 contrast for a UI part. This guard
 * holds the bottom bar, the map's controls and the hero's icon group to it
 * (stage 1 of #479); the rest of the app follows in the stages that issue lists.
 */
const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const css = read("app/globals.css");
const bottomNav = read("components/ui/mzizi-bottom-nav.tsx");
const map = read("app/[location]/map/MapDashboard.tsx");

/** The declaration of a custom property in :root, as written. */
const token = (name: string) =>
  css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();

/** The rule body for a selector at the start of a line (any indentation). */
const rule = (selector: string) => {
  const at = css.search(
    new RegExp(
      `^\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{`,
      "m",
    ),
  );
  expect(at, `no ${selector} rule`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
};

const px = (value: string | undefined) => {
  const m = value?.match(/^([\d.]+)(px|rem)$/);
  if (!m) throw new Error(`not a length: ${value}`);
  return Number(m[1]) * (m[2] === "rem" ? 16 : 1);
};

const channel = (n: number) => {
  const c = n / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
};
const contrast = (a: number, b: number) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
/** `fg` at `alpha` over `bg`, as a luminance. */
const over = (fg: string, bg: string, alpha: number) => {
  const mix = (shift: number) =>
    Math.round(
      alpha * ((parseInt(fg.slice(1), 16) >> shift) & 255) +
        (1 - alpha) * ((parseInt(bg.slice(1), 16) >> shift) & 255),
    );
  return luminance(
    `#${((mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).padStart(6, "0")}`,
  );
};

describe("the Bundu floor, as the registry names it", () => {
  it("is defined once, with the registry's numbers", () => {
    expect(css.match(/--target-floor:/g)).toHaveLength(1);
    expect(token("--target-floor")).toBe("49px");
    expect(token("--inset-floor")).toBe("14px");
    expect(token("--gap-floor")).toBe("7px");
    expect(token("--leading-floor")).toBe("1.5");
  });

  it("is the hit region of every control: --touch-target-min reads the floor", () => {
    expect(token("--touch-target-min")).toBe("var(--target-floor)");
    for (const selector of [".duiker", ".duiker-solid", ".bee"]) {
      const body = rule(selector);
      expect(body, selector).toContain("w-[var(--touch-target-min)]");
      expect(body, selector).toContain("h-[var(--touch-target-min)]");
    }
    expect(rule(".lark")).toContain("min-h-[var(--touch-target-min)]");
    // A pinned item and a chip are at least the floor wide as well as tall.
    expect(bottomNav).toContain("min-h-[var(--touch-target-min)]");
    expect(bottomNav).toContain("min-w-[var(--touch-target-min)]");
  });
});

describe("the float grid is above the floor, never under it", () => {
  it("keeps the inset over 14px and the gap over 7px", () => {
    expect(px(token("--float-inset"))).toBeGreaterThanOrEqual(
      px(token("--inset-floor")),
    );
    expect(px(token("--float-gap"))).toBeGreaterThanOrEqual(
      px(token("--gap-floor")),
    );
  });
});

describe("text in a control keeps the inline inset", () => {
  it("gives a chip and a pinned item the 14px inset, not a number of their own", () => {
    expect(rule(".lark")).toContain("px-[var(--inset-floor)]");
    const link = bottomNav.match(/"(plover [^"]*)",\s*hasLane/);
    expect(link).not.toBeNull();
    expect(bottomNav).toContain("shrink-0 px-[var(--inset-floor)]");
    // No 8px or 12px padding left on a target in the bar.
    for (const source of [link?.[1] ?? "", rule(".lark")]) {
      expect(source).not.toMatch(/(^|\s)px-(2|3)(\s|$)/);
    }
    // The chip's thicker active border still comes out of the same inset.
    expect(css.replace(/\s+/g, " ")).toContain(
      "padding-inline: calc( var(--inset-floor) - (var(--border-width-active) - var(--border-width-rest)) / 2 );",
    );
  });
});

describe("every floating surface has a visible edge", () => {
  it("defines the edge once and uses it on the bar, its targets, the hero group and the map's controls", () => {
    expect(css.match(/--float-border:/g)).toHaveLength(1);
    expect(token("--float-border")).toBe(
      "color-mix(in srgb, var(--foreground) 50%, transparent)",
    );
    expect(bottomNav).toContain("border-[color:var(--float-border)]");
    expect(rule(".plover")).toContain("border-color: var(--float-border)");
    expect(rule(".lark")).toContain("border-[color:var(--float-border)]");
    expect(rule(".hadeda")).toContain(
      "border: var(--border-width-rest) solid var(--float-border)",
    );
    expect(rule(".serval")).toContain("ring-[color:var(--float-border)]");
    // The hairline between the map's two controls is the same edge.
    expect(map).toContain("bg-[color:var(--float-border)]");
  });

  it("is 3:1 or better against the surfaces it sits on, in both themes", () => {
    const [lightFg, darkFg] = css.match(/--foreground:\s*#[0-9a-f]{6}/g) ?? [];
    expect(lightFg && darkFg).toBeTruthy();
    const light = lightFg!.slice(-7);
    const dark = darkFg!.slice(-7);
    // The card (the bar's surface), the page, and the muted fill of a target.
    const lightSurfaces = ["#ffffff", "#faf9f5", "#f3f2ee"];
    const darkSurfaces = ["#100f0e", "#1e1e1e"];
    for (const bg of lightSurfaces) {
      expect(
        contrast(over(light, bg, 0.5), luminance(bg)),
        `light on ${bg}`,
      ).toBeGreaterThanOrEqual(3);
    }
    for (const bg of darkSurfaces) {
      expect(
        contrast(over(dark, bg, 0.5), luminance(bg)),
        `dark on ${bg}`,
      ).toBeGreaterThanOrEqual(3);
    }
    // The old edge was not: --mzizi-border on a card, the reason this exists.
    expect(contrast(luminance("#e7e5e0"), luminance("#ffffff"))).toBeLessThan(
      1.5,
    );
  });
});
