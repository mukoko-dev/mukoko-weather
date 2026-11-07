/**
 * Tests for PlaceLane — the places lane in the phone bottom bar (after the
 * account control; My Location is no longer a chip, owner 2026-11-05). The
 * lane's view renders for real (react-dom/server); the effects (centre the
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
import { canonicalSlug as c } from "@/lib/slug-migration";

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

  it("names the places list", () => {
    const html = view(["harare"], 0);
    expect(html).toContain('aria-label="Saved places and suggestions"');
  });

  it("is a list of links, the places by their text; My Location is not drawn here", () => {
    const html = view(["harare", "nairobi-ke"], 1);
    // The list holds the places only: one item per place.
    expect(html.match(/<li\b/g)).toHaveLength(2);
    // The lane links to the canonical URL of a shipped place (#317).
    expect(html).toContain(`href="/${c("harare")}"`);
    expect(html).toContain(">Harare</span>");
    expect(html).toContain('title="Nairobi"');
    // My Location (`/`) is the round arrow link at the top of the page
    // (MyLocationLink), and the account control is the bar's slot before the
    // lane: neither is a chip.
    expect(html).not.toContain('href="/"');
    expect(html).not.toContain("My Location");
    expect(html).not.toContain("<svg");
  });

  it("marks exactly the current chip with aria-current='page'", () => {
    const html = view(["harare", "nairobi-ke"], 2);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    const tag = (html.match(/<a\b[^>]*aria-current="page"[^>]*>/) ?? [""])[0];
    expect(tag).toContain(`href="/${c("nairobi-ke")}"`);
  });

  it("marks no chip when none is current (e.g. /locations)", () => {
    expect(view(["harare"], -1)).not.toContain("aria-current");
  });

  it("marks no chip on My Location (`/`, index 0): that page has no chip in the lane", () => {
    const html = view(["harare", "nairobi-ke"], 0);
    expect(html).not.toContain("aria-current");
    expect(html.match(/<li\b/g)).toHaveLength(2);
  });

  it("scrolls only the places: the scroller is the whole lane, with nothing pinned or sticky inside it", () => {
    const html = view(["harare", "nairobi-ke"], 1);
    expect(html.indexOf('role="group"')).toBeLessThan(
      html.indexOf("sanderling"),
    );
    expect(html).not.toContain("sticky");
    expect(source.replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain("sticky");
  });

  it("with no places the lane draws nothing (the bar keeps its account control)", () => {
    const html = view([], 0);
    expect(html).toBe("");
    // An empty labelled group would be announced as a group with nothing in it.
    expect(source).toContain("if (places.length === 0) return null;");
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

  it("does not trust the chip order: the places are found by kind, so a home chip is never drawn", () => {
    expect(source).not.toContain('chip.kind === "home"');
    expect(source).toContain('chips.filter((chip) => chip.kind === "place")');
    // A view handed My Location among its chips draws the places only.
    expect(view(["harare"], 0).match(/<li\b/g)).toHaveLength(1);
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

  it("returns the lane to its start when My Location is current (no chip is: `/` is index 0)", () => {
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

  it("moves sideways only: the vertical axis is clipped, not scrollable", () => {
    // `overflow-x: auto` makes `overflow-y` compute to `auto` as well, and the
    // chips' touch targets are taller than the lane, so the lane could be
    // dragged up and down (owner, 2026-11-05).
    const html = view(["harare"], 0);
    expect(html).toContain("overflow-y-hidden");
  });

  it("clips the chips' list to the lane, so the tap region cannot overshoot it", () => {
    // `.lark::after` is as tall as the bar token; the lane inside the bar's
    // border is shorter. Clipping the list is what leaves nothing to scroll.
    const html = view(["harare"], 0);
    expect(html).toMatch(/<ul[^>]*class="[^"]*overflow-clip/);
  });
});

describe("PlaceLane — styling comes from tokens", () => {
  it("uses only design tokens: no inline styles, hex or rgba", () => {
    expect(source).not.toMatch(/style=\{\{/);
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(source).not.toContain("rgba(");
  });

  it("the current chip keeps its outer width: the thicker border comes out of the padding", () => {
    // The chip's own rule is the second one with this selector.
    const at = css.lastIndexOf(
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
    // The fill and text colour are the shared "you are here" rule (a pinned
    // item wears the same); the thicker border is the chip's own.
    const shared = css.indexOf(
      '.plover:is([aria-current]:not([aria-current="false"])),',
    );
    expect(shared).toBeGreaterThan(-1);
    const fill = css.slice(shared, css.indexOf("}", shared));
    expect(fill).toContain(
      '.lark:is([aria-current]:not([aria-current="false"]))',
    );
    expect(fill).toContain("bg-container-cobalt");
    expect(fill).toContain("text-on-container-cobalt");
    // The chip's own rule is the one with this selector that sets a border.
    const rules = [
      ...css.matchAll(
        /\.lark:is\(\[aria-current\]:not\(\[aria-current="false"\]\)\) \{([^}]*)\}/g,
      ),
    ].map((m) => m[1] ?? "");
    const r = rules.find((body) => body.includes("border-width")) ?? "";
    expect(r).toContain("border-width: var(--border-width-active);");
  });

  it("keeps the pill radius on keyboard focus (the global :focus-visible would square it)", () => {
    const at = css.indexOf(".lark:focus-visible {");
    expect(at).toBeGreaterThan(-1);
    const r = css.slice(at, css.indexOf("}", at));
    expect(r).toContain("border-radius: var(--radius-full);");
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
    // mzizi-spacing-exempt: names the classes the lane's list must keep
    expect(source).toContain("p-0 px-1");
    expect(source).toContain("gap-2");
  });
});
