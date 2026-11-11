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

  it("the bottom nav and the Quick actions group are rendered outside <header> (the scrolled header has backdrop-blur)", () => {
    expect(header).toContain("backdrop-blur-xl");
    expect(header.indexOf("<MobileNav")).toBeGreaterThan(
      header.indexOf("</header>"),
    );
    expect(header.indexOf("<QuickActions")).toBeGreaterThan(
      header.indexOf("</header>"),
    );
  });

  it("the header stays sticky to the viewport", () => {
    expect(classNames(header).some((c) => c.includes("sticky top-0"))).toBe(
      true,
    );
  });
});

describe("the Quick actions group (.hadeda) stays fixed to the viewport", () => {
  const body = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `no ${selector} rule`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("is position: fixed at the top right, from the group's position tokens", () => {
    const rule = body("  .hadeda");
    expect(rule).toContain("position: fixed");
    expect(rule).toContain("top: var(--hadeda-top)");
    expect(rule).toContain("right: var(--hadeda-right)");
    expect(rule).not.toContain("env(");
    expect(rule).toMatch(/z-index:\s*40/);
  });

  it("takes the float grid's corner on a phone, and the header row's grid from `sm`", () => {
    // The safe-area maths lives once, in the float grid.
    expect(css).toContain("--hadeda-top: var(--float-top);");
    expect(css).toContain("--hadeda-right: var(--float-right);");
    const sm = css.slice(css.indexOf("@media (min-width: 640px) {\n  :root {"));
    const smBody = sm.slice(0, sm.indexOf("\n}\n"));
    // The header row's own padding and gutter, which the row reads too.
    expect(smBody).toContain("--hadeda-top: var(--chrome-pad-y);");
    expect(css).toContain("--chrome-pad-y: 0.625rem;");
    expect(smBody.replace(/\s+/g, " ")).toContain(
      "--hadeda-right: calc( max(0px, (100% - 0.5rem - var(--chrome-max)) / 2) + var(--chrome-gutter) );",
    );
    expect(header).toContain("pt-[var(--hadeda-top)] pb-[var(--chrome-pad-y)]");
    expect(header).toContain("px-[var(--chrome-gutter)]");
    expect(header).toContain("max-w-[var(--chrome-max)]");
    // The layout's left padding that offsets the header row (0.5rem).
    expect(layout).toContain("min-[480px]:pl-2");
  });

  it("the map's group is the float grid's corner at every width", () => {
    const rule = body('  .hadeda[data-placement="float"]');
    expect(rule).toContain("top: var(--float-top)");
    expect(rule).toContain("right: var(--float-right)");
  });

  it("never blurs, transforms or filters itself (a fixed descendant would be captured)", () => {
    // A backdrop-filter (or transform, filter, contain, will-change) would make
    // the group the containing block of any fixed descendant.
    expect(body("  .hadeda")).not.toMatch(
      /(backdrop-filter|transform|filter|perspective|contain|will-change)\s*:/,
    );
    expect(css).not.toContain(".hadeda::before");
  });

  it("sits in no containing-block ancestor: a sibling of <header>, in the layout's plain wrapper", () => {
    for (const file of [
      "components/layout/QuickActions.tsx",
      "components/layout/AppChrome.tsx",
    ]) {
      for (const c of classNames(read(file))) {
        expect(c, file).not.toMatch(CONTAINING_BLOCK);
      }
    }
  });

  it("sizes itself from its tokens, and the breadcrumb's reserve and the header's slot are derived from the same ones", () => {
    expect(css).not.toContain("--hadeda-inset");
    expect(css).toContain("--hadeda-controls: 3;");
    expect(css).toContain("--hadeda-gap: var(--float-gap);");
    expect(css).toContain("--hadeda-pad: var(--float-pad);");
    // The width is the controls, the gaps between them and the padding around.
    expect(css.replace(/\s+/g, " ")).toContain(
      "--hadeda-width: calc( var(--hadeda-controls) * var(--touch-target-min) + (var(--hadeda-controls) - 1) * var(--hadeda-gap) + 2 * var(--hadeda-pad) );",
    );
    expect(css).toContain(
      "--hadeda-height: calc(var(--touch-target-min) + 2 * var(--hadeda-pad));",
    );
    expect(css).toContain(
      "--hadeda-reserve: calc(var(--hadeda-width) + 0.75rem);",
    );
    // The rule that draws the pill reads the same gap and padding (no second copy).
    const rule = body("  .hadeda");
    expect(rule).toContain("gap: var(--hadeda-gap)");
    expect(rule).toContain("padding: var(--hadeda-pad)");
    expect(rule).not.toMatch(/(?<!-)\b(gap|padding):\s*[\d.]+rem/);
    // The header's slot is the group's own width and height.
    expect(header).toContain(
      "h-[var(--hadeda-height)] w-[var(--hadeda-width)]",
    );
  });

  it("holds exactly as many controls as the tokens say: three up to 767px, four from `md`, five from `lg`", () => {
    const group = read("components/layout/QuickActions.tsx");
    // Share (ShareControl), Notifications (NotificationsButton) and Locations
    // (LocationsLink): the same three on every page.
    const shared =
      (group.match(/<ShareControl/g) ?? []).length +
      (group.match(/<NotificationsButton/g) ?? []).length +
      (group.match(/<LocationsLink/g) ?? []).length;
    const base = css.match(/--hadeda-controls:\s*(\d+);/);
    expect(base).not.toBeNull();
    expect(shared).toBe(Number(base![1]));
    // The header adds the account icon from `md` and Map from `lg` (a phone has
    // them in its bottom bar), because that is what its row can hold beside
    // the brand and the nav (measured: scripts/browser-check/quick-actions.mjs).
    const from = (query: string) => {
      const at = css.indexOf(`@media (min-width: ${query}) {\n  :root {`);
      expect(at, query).toBeGreaterThan(-1);
      const block = css.slice(at, css.indexOf("\n}\n", at));
      return block.match(/--hadeda-controls:\s*(\d+);/)?.[1];
    };
    expect(from("640px")).toBeUndefined();
    const extra = header.slice(header.indexOf("extra={"));
    const mapLink = extra.slice(
      extra.indexOf("href={mapHref}"),
      extra.indexOf("{authedUser ? ("),
    );
    expect(mapLink).toContain('className="bee hidden lg:flex"');
    expect(from("1024px")).toBe(String(shared + 2));
    const account = extra.slice(extra.indexOf("{authedUser ? ("));
    // Both account variants (the profile link and the sign-in link) are `md`.
    expect(account).toContain('className="bee hidden overflow-hidden md:flex"');
    expect(account).toContain('aria-label="Sign in"');
    expect(
      account.slice(account.indexOf('aria-label="Sign in"')).slice(0, 80),
    ).toContain('className="bee hidden md:flex"');
    expect(from("768px")).toBe(String(shared + 1));
    // Every extra is drawn from its breakpoint up only; on a phone the bottom bar holds them.
    for (const link of extra.match(/className="bee [^"]*"/g) ?? []) {
      expect(link).toContain("hidden");
      expect(link).toMatch(/(md|lg):flex/);
    }
    // The brand gives up its wordmark below `md`, and the nav its width below `lg`.
    expect(header).toContain('wordmarkClassName="hidden md:inline"');
    expect(header).toContain('"hidden sm:flex items-center gap-4 lg:gap-6"');
  });

  it("has two looks and no other fill: solid is the brand pill, clear is nothing but the icons", () => {
    const rule = body("  .hadeda");
    expect(rule).toContain("--hadeda-fill: var(--color-primary)");
    expect(rule).toContain("background-color: var(--hadeda-fill)");
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    const clear = css.slice(css.indexOf('.hadeda[data-tone="clear"],'));
    expect(clear.slice(0, clear.indexOf("}"))).toContain(
      "--hadeda-fill: transparent",
    );
  });

  it("cross-fades the fill and the icons over 200ms, and not at all under reduced motion", () => {
    const rule = body("  .hadeda");
    expect(rule).toContain("transition-property: background-color, color");
    expect(rule).toContain("transition-duration: 200ms");
    const reduced = css.slice(
      css.indexOf("@media (prefers-reduced-motion: reduce) {\n    .hadeda,"),
    );
    expect(reduced.slice(0, reduced.indexOf("\n  }\n"))).toContain(
      "transition: none",
    );
  });
});
