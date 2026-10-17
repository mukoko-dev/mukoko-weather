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
    const wrapper = layout.match(/<div className="([^"]*)">\s*\{children\}/);
    expect(wrapper).not.toBeNull();
    expect(wrapper![1]).not.toMatch(CONTAINING_BLOCK);
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
