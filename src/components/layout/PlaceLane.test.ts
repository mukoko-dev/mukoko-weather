/**
 * Tests for PlaceLane — the places lane in the middle of the phone bottom bar.
 * The lane's view renders for real (react-dom/server); the effects (centre the
 * current chip, fade the end edge) are source-checked here, their maths is in
 * src/lib/location-pager.test.ts and MobileNav.render.test.ts covers the whole
 * bar. The sequence itself is shared with the swipe: see
 * src/lib/use-location-pager.test.ts.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { PlaceLaneView } from "./PlaceLane";
import { laneChips, pagerSequence } from "@/lib/location-pager";

const source = readFileSync(resolve(__dirname, "PlaceLane.tsx"), "utf-8");
const css = readFileSync(resolve(__dirname, "../../app/globals.css"), "utf-8");

function view(slugs: string[], activeIndex: number) {
  return renderToStaticMarkup(
    createElement(PlaceLaneView, {
      chips: laneChips(pagerSequence(slugs)),
      activeIndex,
      onChipClick: () => undefined,
    }),
  );
}

/** The body of one `@layer components` rule in globals.css. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}

describe("PlaceLane — accessible lane", () => {
  it("is a labelled group inside the bar's navigation, not a nested nav landmark", () => {
    const html = view(["harare"], 0);
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Places"');
    expect(html).not.toContain("<nav");
    expect(source).not.toMatch(/<nav[\s>]/);
  });

  it("names the places list, so My Location (the link before it) is not an item of it", () => {
    const html = view(["harare"], 0);
    expect(html).toContain('aria-label="Saved places and suggestions"');
    expect(html.indexOf('aria-label="My Location"')).toBeLessThan(
      html.indexOf("<ul"),
    );
  });

  it("is a list of links: My Location named by aria-label, places by their text", () => {
    const html = view(["harare", "nairobi-ke"], 1);
    // My Location is the pinned link before the list; the list holds the places.
    expect(html.match(/<li\b/g)).toHaveLength(2);
    expect(html).toContain('aria-label="My Location"');
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/harare"');
    expect(html).toContain(">Harare</span>");
    expect(html).toContain('title="Nairobi"');
  });

  it("marks exactly the current chip with aria-current='page'", () => {
    const html = view(["harare", "nairobi-ke"], 2);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    const tag = (html.match(/<a\b[^>]*aria-current="page"[^>]*>/) ?? [""])[0];
    expect(tag).toContain('href="/nairobi-ke"');
  });

  it("marks no chip when none is current (e.g. /locations)", () => {
    expect(view(["harare"], -1)).not.toContain("aria-current");
  });

  it("pins My Location by keeping it OUTSIDE the scroller, before the places", () => {
    const html = view(["harare", "nairobi-ke"], 1);
    const home = html.indexOf('aria-label="My Location"');
    const scroller = html.indexOf("sanderling");
    expect(home).toBeGreaterThan(0);
    expect(home).toBeLessThan(scroller);
    // Not in the list: the list holds the places only.
    expect(html.match(/<li\b/g)).toHaveLength(2);
    expect(html).not.toContain("sticky");
    expect(source.replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain("sticky");
  });

  it("with no places the lane is My Location alone, centred, and renders no scroller", () => {
    const html = view([], 0);
    expect(html).toContain("justify-center");
    expect(html).not.toContain("sanderling");
    expect(html).not.toContain("<ul");
    expect(html).toContain(">My Location</span>");
  });

  it("keeps real links so a new tab, a middle click and no-JS still work", () => {
    expect(source).toContain("href={chip.href}");
    expect(source).toContain("handlePlaceLinkClick(event, chip.href");
    expect(source).toContain("router.push(href)");
  });

  it("switches place in place on a plain click", () => {
    expect(source).toContain(
      "usePagerSequence(savedLocations, selectedLocation)",
    );
    expect(source).toContain("handlePlaceLinkClick(event, chip.href");
  });

  it("counts a place change only for a plain click on a chip that is not the current one", () => {
    expect(source).toContain(
      "if (chip.slug && isPlainLeftClick(event) && chip.slug !== from) {",
    );
    // The count comes before the switch, and a modified click never reaches it.
    expect(source.indexOf("trackPlaceChange(chip.href")).toBeLessThan(
      source.indexOf("handlePlaceLinkClick(event"),
    );
  });

  it("names a chip through laneChipName with the person's labels and the names seen", () => {
    expect(source).toContain(
      "laneChipName(slug, locationLabels, locationNames)",
    );
  });

  it("does not trust the chip order: My Location and the places are found by kind", () => {
    expect(source).toContain('chips.find((chip) => chip.kind === "home")');
    expect(source).toContain('chips.filter((chip) => chip.kind === "place")');
    // A view given no chips renders an empty lane instead of throwing.
    expect(() =>
      renderToStaticMarkup(
        createElement(PlaceLaneView, {
          chips: [],
          activeIndex: -1,
          onChipClick: () => undefined,
        }),
      ),
    ).not.toThrow();
  });
});

describe("PlaceLane — scrolling", () => {
  it("scrolls with the current chip centred, honouring reduced motion", () => {
    expect(source).toContain("scroller.scrollTo({");
    expect(source).toContain("behavior: getScrollBehavior()");
    expect(source).toContain("laneScrollLeft(");
    expect(source).toContain("[activeIndex, chips.length]");
  });

  it("returns the lane to its start when My Location is current", () => {
    expect(source).toContain("active ? activeIndex : 0");
  });

  it("leaves the lane where the person scrolled it when no chip is current", () => {
    // /locations and /explore have no current chip: no scroll at all.
    expect(source).toContain("if (activeIndex < 0) return;");
    expect(source.indexOf("if (activeIndex < 0) return;")).toBeLessThan(
      source.indexOf("scroller.scrollTo({"),
    );
  });

  it("centres again once the fonts are in, and never after it has been cleaned up", () => {
    expect(source).toContain("document.fonts?.ready.then(");
    expect(source).toContain("if (!cancelled) centre();");
  });

  it("fades an edge only while more chips lie that way, and follows resizes", () => {
    expect(source).toContain(
      'data-fade-start={more.before ? "true" : undefined}',
    );
    expect(source).toContain('data-fade-end={more.after ? "true" : undefined}');
    expect(source).toContain("new ResizeObserver(measureFade)");
    expect(source).toContain("observer.disconnect()");
    const html = view(["harare"], 0);
    expect(html).not.toContain("data-fade-start");
    expect(html).not.toContain("data-fade-end");
  });

  it("does not snap: the lane centres the current chip itself, with no second positioning rule", () => {
    expect(source).not.toContain("snap-");
    expect(rule(".sanderling")).not.toContain("scroll-snap");
  });

  it("hides the scrollbar and lets the lane shrink inside the bar", () => {
    const html = view(["harare"], 0);
    expect(html).toContain("scrollbar-hide");
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("min-w-0");
  });
});

describe("PlaceLane — styling comes from tokens", () => {
  it("uses only design tokens: no inline styles, hex or rgba", () => {
    expect(source).not.toMatch(/style=\{\{/);
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(source).not.toContain("rgba(");
  });

  it("the current chip keeps its outer width: the thicker border comes out of the padding", () => {
    const at = css.indexOf(
      '.lark:is([aria-current]:not([aria-current="false"])) {',
    );
    const r = css.slice(at, css.indexOf("}", at + 200));
    expect(r).toContain("padding-inline: calc(");
    expect(r).toContain(
      "(var(--border-width-active) - var(--border-width-rest)) / 2",
    );
  });

  it(".lark is never wider than the lane it sits in, so one chip always fits whole", () => {
    const r = rule(".lark");
    expect(r).toContain("max-width: min(10rem, calc(100cqw - 0.5rem));");
    expect(rule(".sanderling")).toContain("container-type: inline-size;");
  });

  it(".lark is a full pill, one touch target tall, with the label token and a full hairline border", () => {
    const r = rule(".lark");
    expect(r).toContain("min-h-[var(--touch-target-min)]");
    expect(r).toContain("rounded-full");
    expect(r).toContain("text-[length:var(--text-nav-label)]");
    expect(r).toContain("border-style: solid;");
    expect(r).toContain("border-width: var(--border-width-rest);");
    // A one-sided stripe is another brand's pattern (mzizi-surfaces.test.ts).
    expect(r).not.toMatch(/border-(left|right)/);
  });

  it("the current chip takes the cobalt container fill and the active border width", () => {
    const at = css.indexOf(
      '.lark:is([aria-current]:not([aria-current="false"])) {',
    );
    expect(at).toBeGreaterThan(-1);
    const r = css.slice(at, css.indexOf("}", at));
    expect(r).toContain("bg-container-cobalt");
    expect(r).toContain("text-on-container-cobalt");
    expect(r).toContain("border-width: var(--border-width-active);");
  });

  it("keeps the pill radius on keyboard focus (the global :focus-visible would square it)", () => {
    const at = css.indexOf(".lark:focus-visible {");
    expect(at).toBeGreaterThan(-1);
    const r = css.slice(at, css.indexOf("}", at));
    expect(r).toContain("border-radius: 9999px;");
    // Inset: the lane's scroller clips anything drawn outside it.
    expect(r).toContain("outline-offset: -3px;");
  });

  it(".sanderling fades its edges by an alpha-only mask driven by two tokens", () => {
    const r = rule(".sanderling");
    expect(r).toContain("--lane-fade-start: 0px;");
    expect(r).toContain("--lane-fade-end: 0px;");
    expect(r).toContain("mask-image: linear-gradient(");
    // Alpha only: no colour, so it works on any theme.
    expect(r).not.toMatch(/#[0-9a-fA-F]{3,6}\b|rgb/);
    expect(rule('.sanderling[data-fade-start="true"]')).toContain(
      "--lane-fade-start: 1.25rem;",
    );
    expect(rule('.sanderling[data-fade-end="true"]')).toContain(
      "--lane-fade-end: 2rem;",
    );
  });

  it("gives the scroller room so a chip's focus ring and ends are not clipped", () => {
    expect(source).toContain("p-0 px-1");
    expect(source).toContain("gap-2");
  });
});
