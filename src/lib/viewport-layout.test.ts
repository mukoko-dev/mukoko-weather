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

/** All declarations of a top-level rule (`html {`, `body {`). */
function topLevelRules(selector: string): string[] {
  const re = new RegExp(`(^|\\n)${selector} \\{([^}]*)\\}`, "g");
  return [...css.matchAll(re)].map((m) => m[2]);
}

/** className strings of every element, in source order. */
function classNames(src: string): string[] {
  return [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map(
    (m) => m[1] ?? m[2],
  );
}

const CONTAINING_BLOCK =
  /\b(transform|translate-|scale-|rotate-|skew-|filter|blur-|backdrop-|perspective|contain-|will-change|animate-fade-in-up|animate-scale-in|animate-slide)/;

describe("html and body never become scroll containers", () => {
  it("html uses overflow-x: clip, not hidden", () => {
    const rules = topLevelRules("html");
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r).not.toMatch(/overflow(-x|-y)?:\s*hidden/);
    expect(rules.join("")).toContain("overflow-x: clip");
  });

  it("body uses overflow-x: clip, not hidden, and keeps overscroll-behavior-x", () => {
    const rules = topLevelRules("body");
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r).not.toMatch(/overflow(-x|-y)?:\s*hidden/);
    expect(rules.join("")).toContain("overflow-x: clip");
    expect(rules.join("")).toContain("overscroll-behavior-x: none");
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
