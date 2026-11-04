/**
 * The vendored Mzizi bottom nav, rendered for real: the registry's single
 * `items` row stays exactly that, and the local `leading` / `lane` /
 * `trailing` layout (documented as deviation 10 in the file header) puts
 * pinned items at the edges and the lane in the middle.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

vi.mock("next/navigation", () => ({ usePathname: () => "/one" }));

import {
  MziziBottomNav,
  isBottomNavItemActive,
  type BottomNavItem,
} from "./mzizi-bottom-nav";

const Icon = () => createElement("svg");
const item = (id: string, href = `/${id}`): BottomNavItem => ({
  id,
  label: id,
  href,
  icon: Icon,
});

const source = readFileSync(
  resolve(__dirname, "mzizi-bottom-nav.tsx"),
  "utf-8",
);

describe("MziziBottomNav — the registry row (items) is unchanged", () => {
  const html = renderToStaticMarkup(
    createElement(MziziBottomNav, {
      items: [item("one"), item("two")],
    }),
  );

  it("spreads items evenly and renders no lane", () => {
    expect(html).toContain("justify-around");
    expect(html).not.toContain("mzizi-bottom-nav-lane");
  });

  it("marks the item that matches the path with aria-current", () => {
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    const current = html.match(/<a\b[^>]*aria-current="page"[^>]*>/)![0];
    expect(current).toContain('href="/one"');
  });
});

describe("MziziBottomNav — leading, lane, trailing", () => {
  const html = renderToStaticMarkup(
    createElement(MziziBottomNav, {
      leading: [item("one")],
      lane: createElement("div", { id: "the-lane" }, "lane"),
      trailing: [item("two")],
      label: "Mobile navigation",
    }),
  );

  it("orders the parts: leading, the lane slot, trailing", () => {
    const a = html.indexOf('href="/one"');
    const lane = html.indexOf('data-slot="mzizi-bottom-nav-lane"');
    const content = html.indexOf('id="the-lane"');
    const b = html.indexOf('href="/two"');
    expect(a).toBeGreaterThan(0);
    expect(lane).toBeGreaterThan(a);
    expect(content).toBeGreaterThan(lane);
    expect(b).toBeGreaterThan(content);
  });

  it("is one landmark and one surface, with the lane free to shrink", () => {
    expect(html.match(/<nav\b/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Mobile navigation"');
    expect(html).toContain("flex h-full min-w-0 flex-1 items-center");
    expect(html).not.toContain("justify-around");
  });

  it("gives every pinned item the same preset width, never one taken from its label", () => {
    const widths = [...html.matchAll(/<a\b[^>]*class="([^"]*)"/g)].map(
      (m) => m[1],
    );
    expect(widths).toHaveLength(2);
    for (const cls of widths) {
      expect(cls).toContain("w-[var(--mobile-nav-item-width)]");
      expect(cls).toContain("max-[359px]:w-[var(--touch-target-min)]");
      expect(cls).toContain("shrink-0");
      expect(cls).toContain("px-[var(--inset-floor)]");
      // the only minimum is the Bundu floor itself (49px), which a preset
      // width never falls under; a label-sized minimum would let a long label
      // widen the button
      expect(cls).toContain("min-w-[var(--touch-target-min)]");
      expect(cls).not.toMatch(/(^|\s)min-w-(?!\[var\(--touch-target-min\)\])/);
    }
    // the same classes for "one" and "two", so their widths cannot differ
    const sizing = (cls: string) =>
      cls
        .split(" ")
        .filter((c) => /(^|:)(w|min-w|max-w|shrink|px)-/.test(c))
        .sort();
    expect(sizing(widths[0])).toEqual(sizing(widths[1]));
  });

  it("cuts a label longer than the preset instead of widening the button", () => {
    const wide = renderToStaticMarkup(
      createElement(MziziBottomNav, {
        leading: [{ ...item("one"), label: "A much longer label" }],
        lane: createElement("div"),
        trailing: [{ ...item("two"), label: "Hi" }],
      }),
    );
    const classes = [...wide.matchAll(/<a\b[^>]*class="([^"]*)"/g)].map(
      (m) => m[1],
    );
    expect(classes[0]).toContain("w-[var(--mobile-nav-item-width)]");
    expect(classes[1]).toContain("w-[var(--mobile-nav-item-width)]");
    expect(wide).toContain("min-w-0 max-w-full truncate");
    expect(wide).not.toContain("min-w-[60px]");
  });

  it("collapses the pinned labels to screen-reader-only on a very small phone, keeping the name", () => {
    expect(html).toContain("max-[359px]:sr-only");
    // The registry row keeps its visible labels at every width.
    const row = renderToStaticMarkup(
      createElement(MziziBottomNav, { items: [item("one")] }),
    );
    expect(row).not.toContain("sr-only");
    expect(row).toContain("min-w-[60px]");
  });
});

describe("MziziBottomNav — the layout props are a union", () => {
  it("refuses items together with a lane at the type level, and documents it", () => {
    expect(source).toContain("type MziziBottomNavLayout =");
    expect(source).toContain("items?: undefined;");
    expect(source).toContain("lane?: undefined;");
    expect(source).toContain("lane: React.ReactNode;");
  });

  it("is app-agnostic: no import from this app's feature code", () => {
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map(
      (m) => m[1],
    );
    expect(imports.sort()).toEqual(
      [
        "@/lib/utils",
        "lucide-react",
        "next/link",
        "next/navigation",
        "react",
      ].sort(),
    );
  });

  it("documents the lane as a deviation in the file header", () => {
    const header = source.slice(0, source.indexOf("import * as React"));
    expect(header).toContain("10. A LANE between pinned items");
    expect(header).toContain("`leading`");
    expect(header).toContain("`lane`");
    expect(header).toContain("`trailing`");
  });
});

describe("isBottomNavItemActive", () => {
  it("an explicit active id wins over the path", () => {
    expect(isBottomNavItemActive(item("a"), "/b", "a")).toBe(true);
    expect(isBottomNavItemActive(item("a"), "/a", "b")).toBe(false);
  });
});
