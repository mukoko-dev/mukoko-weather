/**
 * Guard: the sticky header and the fixed bottom nav stay attached to the
 * viewport.
 *
 * - `overflow-x: hidden` on html or body (or on a wrapper around the page
 *   shell) makes that element a scroll container: `position: sticky` then
 *   sticks to it instead of the viewport (the header scrolls away), and iOS
 *   Safari detaches or jitters `position: fixed` children. `overflow-x: clip`
 *   cuts horizontal overflow without creating a scroll container.
 * - A `transform`, `filter`, `backdrop-filter`, `perspective`, `contain` or
 *   `will-change` on an ancestor makes it the containing block of a fixed
 *   descendant, so the "fixed" nav would scroll with that ancestor. That
 *   includes an animation that leaves a transform behind (fill-mode
 *   forwards/both).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const SRC = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf-8");

const css = read("app/globals.css");
const layout = read("app/layout.tsx");
const dashboard = read("app/[location]/WeatherDashboard.tsx");
const header = read("components/layout/Header.tsx");

/** className strings of every element, in source order. */
function classNames(src: string): string[] {
  return [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map(
    (m) => m[1] ?? m[2],
  );
}

const CONTAINING_BLOCK =
  /\b(transform|translate-|scale-|rotate-|skew-|filter|blur-|backdrop-|perspective|contain-|will-change|animate-fade-in-up|animate-scale-in|animate-slide)/;

/**
 * Every rule, at any nesting depth (inside @media, @supports, @layer…),
 * that targets html / :root / body itself, with its declarations. Works on
 * innermost blocks, so a nested override cannot hide from it.
 */
export function rootElementRules(
  source: string,
): { element: "html" | "body"; selector: string; body: string }[] {
  const out: { element: "html" | "body"; selector: string; body: string }[] =
    [];
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of noComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const raw of m[1].split(",")) {
      const sel = raw.trim();
      const hit = sel.match(
        /^(html|body|:root)((\[[^\]]*\])|(:[\w-]+(\([^)]*\))?))*$/,
      );
      if (!hit) continue;
      out.push({
        element: hit[1] === "body" ? "body" : "html",
        selector: sel,
        body: m[2],
      });
    }
  }
  return out;
}

const SCROLL_CONTAINER = /overflow(-x|-y)?\s*:\s*(hidden|auto|scroll)/;
/** The one allowed html pattern: a `hidden` fallback immediately overridden by `clip`. */
const HTML_FALLBACK = /overflow-x\s*:\s*hidden\s*;\s*overflow-x\s*:\s*clip/;

/** Rules that would make html or body a scroll container (or hide that). */
export function overflowViolations(source: string): string[] {
  const bad: string[] = [];
  for (const r of rootElementRules(source)) {
    if (!SCROLL_CONTAINER.test(r.body)) continue;
    if (r.element === "html") {
      const rest = r.body.replace(HTML_FALLBACK, "");
      if (!SCROLL_CONTAINER.test(rest)) continue;
    }
    bad.push(`${r.selector} { ${r.body.trim()} }`);
  }
  return bad;
}

describe("overflowViolations (the guard itself)", () => {
  it("catches body hidden at the top level and inside nested at-rules", () => {
    expect(overflowViolations("body { overflow-x: hidden; }")).toHaveLength(1);
    expect(
      overflowViolations(
        "@media (max-width: 600px) { @supports (display:grid) { body { overflow-x: hidden } } }",
      ),
    ).toHaveLength(1);
    expect(overflowViolations("html, body { overflow: hidden; }")).toHaveLength(
      2,
    );
    expect(
      overflowViolations(':root[data-theme="dark"] { overflow-y: auto; }'),
    ).toHaveLength(1);
  });

  it("allows only the html hidden-then-clip fallback, never on body", () => {
    expect(
      overflowViolations("html { overflow-x: hidden; overflow-x: clip; }"),
    ).toEqual([]);
    expect(
      overflowViolations("body { overflow-x: hidden; overflow-x: clip; }"),
    ).toHaveLength(1);
    expect(
      overflowViolations("html { overflow-x: clip; overflow-x: hidden; }"),
    ).toHaveLength(1);
  });

  it("ignores other selectors and comments", () => {
    expect(
      overflowViolations(
        "/* body { overflow-x: hidden } */ .card body-copy { overflow: hidden } main { overflow-x: hidden }",
      ),
    ).toEqual([]);
  });
});

describe("html and body never become scroll containers", () => {
  it("no rule anywhere in globals.css (nested @media included) breaks it", () => {
    expect(overflowViolations(css)).toEqual([]);
  });

  it("html clips, with the hidden fallback for browsers without clip", () => {
    const html = rootElementRules(css).filter((r) => r.selector === "html");
    expect(html.some((r) => HTML_FALLBACK.test(r.body))).toBe(true);
  });

  it("body clips (no fallback) and keeps overscroll-behavior-x", () => {
    const body = rootElementRules(css)
      .filter((r) => r.selector === "body")
      .map((r) => r.body)
      .join("");
    expect(body).toContain("overflow-x: clip");
    expect(body).not.toMatch(/overflow-x:\s*hidden/);
    expect(body).toContain("overscroll-behavior-x: none");
  });
});

describe("no wrapper around the page shell clips with overflow hidden", () => {
  it("the root layout's page wrapper clips instead of hiding", () => {
    expect(layout).toContain('<div className="overflow-x-clip');
    expect(layout).not.toMatch(/overflow-(x-|y-)?hidden/);
  });

  it("the location dashboard's main column clips instead of hiding", () => {
    expect(dashboard).not.toMatch(/overflow-(x-|y-)?hidden/);
    expect(dashboard).toContain("overflow-x-clip");
  });
});

describe("the header and the bottom nav are not inside a containing-block ancestor", () => {
  it("the root layout wrapper around {children} has no transform/filter/contain/will-change", () => {
    const wrapper = layout.match(
      /<div className="([^"]*)">\s*<AppChrome>\{children\}<\/AppChrome>/,
    );
    expect(wrapper).not.toBeNull();
    expect(wrapper![1]).not.toMatch(CONTAINING_BLOCK);
  });

  it("the persistent chrome sits inside that wrapper, once, beside the page", () => {
    const chrome = read("components/layout/AppChrome.tsx");
    expect(chrome).toContain("<SiteHeader />");
    expect(chrome).toContain("{children}");
    expect(chrome).not.toMatch(/\b(transform|filter|will-change)\b/);
  });

  it("the dashboard's content layer (parent of Header) has no transform/filter/contain/will-change", () => {
    const idx = dashboard.indexOf("<Header />");
    const before = dashboard.slice(0, idx);
    const open = [...before.matchAll(/<div className="([^"]*)">/g)].pop();
    expect(open).toBeDefined();
    expect(open![1]).toBe("relative z-10");
    expect(open![1]).not.toMatch(CONTAINING_BLOCK);
  });

  it("the bottom nav is rendered outside <header> (the scrolled header has backdrop-blur)", () => {
    expect(header).toContain("backdrop-blur-xl");
    expect(header.indexOf("<MobileNav")).toBeGreaterThan(
      header.indexOf("</header>"),
    );
  });

  it("the header stays sticky to the viewport", () => {
    expect(classNames(header).some((c) => c.includes("sticky top-0"))).toBe(
      true,
    );
  });
});

describe("the hero's phone icon group (.hadeda) stays fixed to the viewport", () => {
  const body = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `no ${selector} rule`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("is position: fixed at the top right, from the inset tokens and the safe area", () => {
    const rule = body("  .hadeda");
    expect(rule).toContain("position: fixed");
    // The safe-area maths lives once, in the float grid.
    expect(rule).toContain("top: var(--float-top)");
    expect(rule).toContain("right: var(--float-right)");
    expect(rule).not.toContain("env(");
    expect(rule).toMatch(/z-index:\s*40/);
  });

  it("never blurs, transforms or filters itself: its blur is on a pseudo-element", () => {
    // A backdrop-filter (or transform, filter, contain, will-change) would make
    // the group the containing block of the profile menu's fixed panel.
    expect(body("  .hadeda")).not.toMatch(
      /(backdrop-filter|transform|filter|perspective|contain|will-change)\s*:/,
    );
    const before = body("  .hadeda::before");
    expect(before).toContain("backdrop-filter: blur(");
    expect(before).toMatch(/z-index:\s*-1/);
  });

  it("sits in no containing-block ancestor in the hero or its section wrapper", () => {
    for (const file of [
      "components/weather/CurrentConditions.tsx",
      "components/weather/DraggableSection.tsx",
    ]) {
      for (const c of classNames(read(file))) {
        expect(c, file).not.toMatch(CONTAINING_BLOCK);
      }
    }
  });

  it("sizes itself from its tokens, and the breadcrumb's reserve is derived from the same ones", () => {
    expect(css).not.toContain("--hadeda-inset");
    expect(css).toContain("--hadeda-controls: 2;");
    expect(css).toContain("--hadeda-gap: var(--float-gap);");
    expect(css).toContain("--hadeda-pad: var(--float-pad);");
    // The width is the controls, the gaps between them and the padding around.
    expect(css.replace(/\s+/g, " ")).toContain(
      "--hadeda-width: calc( var(--hadeda-controls) * var(--touch-target-min) + (var(--hadeda-controls) - 1) * var(--hadeda-gap) + 2 * var(--hadeda-pad) );",
    );
    expect(css).toContain(
      "--hadeda-reserve: calc(var(--hadeda-width) + 0.75rem);",
    );
    // The rule that draws the pill reads the same gap and padding (no second copy).
    const rule = body("  .hadeda");
    expect(rule).toContain("gap: var(--hadeda-gap)");
    expect(rule).toContain("padding: var(--hadeda-pad)");
    expect(rule).not.toMatch(/(?<!-)\b(gap|padding):\s*[\d.]+rem/);
  });

  it("holds exactly as many controls as the token says", () => {
    const hero = read("components/weather/CurrentConditions.tsx");
    const group = hero.slice(hero.indexOf('className="hadeda sm:hidden"'));
    const end = group.indexOf("</div>\n      </div>");
    const inner = group.slice(0, end);
    // Share (ShareControl) and the profile menu (PhoneMenu).
    const controls =
      (inner.match(/<ShareControl/g) ?? []).length +
      (inner.match(/<PhoneMenu/g) ?? []).length;
    const token = css.match(/--hadeda-controls:\s*(\d+);/);
    expect(token).not.toBeNull();
    expect(controls).toBe(Number(token![1]));
  });

  it("is a card surface with the Mzizi border: 0.5px token border, shadow, 90% card fill", () => {
    const rule = body("  .hadeda");
    expect(rule).toContain(
      "border: var(--border-width-rest) solid var(--float-border)",
    );
    expect(rule).toContain("var(--card) 90%");
    expect(rule).toContain("box-shadow: var(--shadow-lg)");
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
