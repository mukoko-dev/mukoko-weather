/**
 * The phone bottom bar rendered for real (react-dom/server): what a visitor's
 * HTML contains for no places, a few and many, on each kind of page. Effects
 * do not run on the server, so the scroll-into-view and fade are covered by
 * the pure maths in src/lib/location-pager.test.ts and, in a real browser, by
 * the PR's runtime check.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/" }));
const store = vi.hoisted(() => ({
  hiddenPresetSlugs: [] as string[],
  presetAnchor: null as unknown,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));
vi.mock("@/lib/store", () => ({
  useAppStore: (select: (s: typeof store) => unknown) => select(store),
}));
// Suggested places depend on a geographic anchor; these tests are about the
// places a person saved.
vi.mock("@/lib/location-presets", () => ({
  visiblePresetSlugs: () => [],
}));

import { MobileNav } from "./MobileNav";

function render(
  pathname: string,
  savedLocations: string[] = [],
  extra: Record<string, unknown> = {},
) {
  nav.pathname = pathname;
  return renderToStaticMarkup(
    createElement(MobileNav, {
      pathname,
      savedLocations,
      selectedLocation: "harare",
      mapHref: "/harare/map",
      hasMapLocation: true,
      ...extra,
    }),
  );
}

/** Every `<a ...>` opening tag in the markup. */
function anchors(html: string): string[] {
  return html.match(/<a\b[^>]*>/g) ?? [];
}
const current = (html: string) =>
  (html.match(/aria-current="page"/g) ?? []).length;

beforeEach(() => {
  store.hiddenPresetSlugs = [];
  store.presetAnchor = null;
});

describe("MobileNav render — one bar, one landmark", () => {
  it("renders exactly one <nav>, labelled, with no second pager pill", () => {
    const html = render("/", ["harare", "nairobi-ke"]);
    expect(html.match(/<nav\b/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Mobile navigation"');
    expect(html).not.toContain("mzizi-bottom-nav-indicator");
    expect(html).not.toContain("Location pages");
    expect(html).not.toContain("mzizi-bottom-nav-bar");
  });

  it("is phone-only and sits on the one floating surface", () => {
    const html = render("/");
    expect(html).toContain("sm:hidden");
    expect(html).toContain("bg-card/90");
    expect(html).toContain("backdrop-blur-xl");
    expect(html).toContain("h-[var(--mobile-nav-bar-height)]");
  });

  it("has Map first, the places lane in the middle and Locations last", () => {
    const html = render("/", ["harare"]);
    const map = html.indexOf('aria-label="Weather map"');
    const lane = html.indexOf('data-slot="mzizi-bottom-nav-lane"');
    const group = html.indexOf('aria-label="Places"');
    const locations = html.indexOf('aria-label="All locations"');
    expect(map).toBeGreaterThan(0);
    expect(lane).toBeGreaterThan(map);
    expect(group).toBeGreaterThan(lane);
    expect(locations).toBeGreaterThan(group);
  });

  it("points Map at the map route of the location on screen, or at Explore with none", () => {
    expect(render("/")).toContain('href="/harare/map"');
    const none = render("/", [], {
      mapHref: "/explore",
      hasMapLocation: false,
    });
    expect(none).toContain('href="/explore"');
    expect(none).toContain(
      'aria-label="Choose a location for the weather map"',
    );
  });

  it("keeps Map and Locations as 48px targets with the 16px label token", () => {
    const html = render("/");
    expect(
      html.match(/min-h-\[var\(--touch-target-min\)\]/g)!.length,
    ).toBeGreaterThanOrEqual(2);
    expect(html).toContain("text-[length:var(--text-nav-label)]");
  });
});

describe("MobileNav render — the places lane", () => {
  it("puts My Location first, then the places in order, each a real link", () => {
    const html = render("/", ["harare", "nairobi-ke", "lagos-ng"]);
    const hrefs = anchors(html).map((a) => a.match(/href="([^"]*)"/)?.[1]);
    const laneHrefs = hrefs.filter(
      (h) => h !== "/harare/map" && h !== "/locations",
    );
    expect(laneHrefs).toEqual(["/", "/harare", "/nairobi-ke", "/lagos-ng"]);
  });

  it("names the chips: My Location by label, places by their visible name", () => {
    const html = render("/", ["harare", "nairobi-ke"]);
    expect(html).toContain('aria-label="My Location"');
    expect(html).toContain(">Harare</span>");
    expect(html).toContain(">Nairobi</span>");
  });

  it("is never empty: with no places it is My Location alone, spelled out", () => {
    const html = render("/");
    const chips = html.match(/class="lark[^"]*"/g) ?? [];
    expect(chips).toHaveLength(1);
    expect(html).toContain(">My Location</span>");
  });

  it("shows My Location as the glyph alone once places sit beside it", () => {
    const html = render("/explore", ["harare"]);
    expect(html).not.toContain(">My Location</span>");
    expect(html).toContain('aria-label="My Location"');
    expect(html).toContain("min-w-[var(--touch-target-min)] px-0");
  });

  it("pins My Location outside the scroller and lets the places scroll beside it", () => {
    const html = render("/", ["harare", "nairobi-ke"]);
    expect(html.indexOf('aria-label="My Location"')).toBeLessThan(
      html.indexOf("sanderling"),
    );
    expect(html).not.toContain("sticky");
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("scrollbar-hide");
    expect(html).not.toContain("snap-");
  });

  it("gives every chip a 48px target through the .lark class, not a smaller hit area", () => {
    const html = render("/", ["harare", "a-b", "c-d"]);
    const chips = (html.match(/class="lark[^"]*"/g) ?? []).length;
    expect(chips).toBe(4);
    expect(html).not.toContain("h-8");
    expect(html).not.toContain("h-10");
  });

  it("renders up to MAX_PAGER_DOTS places, all reachable", () => {
    const many = Array.from({ length: 10 }, (_, i) => `place-${i}`);
    const html = render("/", many);
    expect((html.match(/class="lark[^"]*"/g) ?? []).length).toBe(11);
  });
});

describe("MobileNav render — aria-current is on exactly the current item", () => {
  it("is My Location on /", () => {
    const html = render("/", ["harare", "nairobi-ke"]);
    expect(current(html)).toBe(1);
    const tag = anchors(html).find((a) => a.includes('aria-current="page"'))!;
    expect(tag).toContain('href="/"');
    expect(tag).toContain('aria-label="My Location"');
  });

  it("is the place's chip on its page", () => {
    const html = render("/nairobi-ke", ["harare", "nairobi-ke"]);
    expect(current(html)).toBe(1);
    expect(anchors(html).find((a) => a.includes("aria-current"))).toContain(
      'href="/nairobi-ke"',
    );
  });

  it("is the place's chip on a sub-route like its map", () => {
    const html = render("/harare/map", ["harare"], { mapHref: "/harare/map" });
    expect(current(html)).toBe(1);
  });

  it("is Locations on /locations, and no chip", () => {
    const html = render("/locations", ["harare"]);
    expect(current(html)).toBe(1);
    expect(anchors(html).find((a) => a.includes("aria-current"))).toContain(
      'href="/locations"',
    );
  });

  it("is nothing on /explore (Map never lights up there, even though it links to Explore)", () => {
    const html = render("/explore", ["harare"], {
      mapHref: "/explore",
      hasMapLocation: false,
    });
    expect(current(html)).toBe(0);
  });

  it("marks the active chip with the lark class that the CSS fills, not a colour in markup", () => {
    const html = render("/", ["harare"]);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(html).not.toContain("style=");
  });
});
