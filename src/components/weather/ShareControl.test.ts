/**
 * ShareControl: the hero's round Share control, rendered for real
 * (react-dom/server) plus source checks for what a render cannot show (the
 * click handler, the timers).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ShareControl } from "./ShareControl";

const source = readFileSync(resolve(__dirname, "ShareControl.tsx"), "utf-8");

const render = (variant: "sky" | "card") =>
  renderToStaticMarkup(
    createElement(ShareControl, {
      slug: "harare",
      locationName: "Harare",
      variant,
    }),
  );

describe("ShareControl — one control, two homes", () => {
  it("is a round kestrel-round button on the sky and a round duiker button in the phone icon group", () => {
    expect(render("sky")).toMatch(/<button[^>]*class="kestrel-round"/);
    expect(render("card")).toMatch(/<button[^>]*class="duiker"/);
    expect(render("sky")).not.toContain("duiker");
    expect(render("card")).not.toContain("kestrel-round");
  });

  it("is icon-only: its name is the aria-label, the glyph is hidden from assistive tech", () => {
    for (const variant of ["sky", "card"] as const) {
      const html = render(variant);
      expect(html).toContain('aria-label="Share weather for Harare"');
      expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    }
  });

  it("holds an empty polite status region until there is something to say", () => {
    for (const variant of ["sky", "card"] as const) {
      expect(render(variant)).toMatch(
        /<span role="status" class="sr-only"><\/span>/,
      );
    }
  });

  it("styles the note for where it sits: white text on the sky, its own card surface in the group", () => {
    expect(source).toContain("sky: ");
    expect(source).toContain("card: ");
    const card = source.match(/card: "([^"]*)"/)?.[1] ?? "";
    // Over the cards that scroll under the fixed group, the note needs a
    // surface and a text colour that are not the sky foreground.
    expect(card).toContain("serval");
    expect(card).toContain("text-text-primary");
    const sky = source.match(/sky: "([^"]*)"/)?.[1] ?? "";
    expect(sky).not.toContain("serval");
  });
});

describe("ShareControl — behaviour", () => {
  it("uses the Web Share API when there is one", () => {
    expect(source).toContain("navigator.share");
    expect(source).toContain("share(shareData)");
  });

  it("falls back to copying the link, and says so (and says when that failed)", () => {
    expect(source).toMatch(/navigator\.clipboard\s*\.writeText/);
    expect(source).toContain("Link copied");
    expect(source).toContain("Copy failed");
    expect(source).toContain("setCopied(true)");
    expect(source).toContain("setCopyFailed(true)");
  });

  it("clears each note after 2 seconds, and its timer on unmount", () => {
    expect(
      source.match(
        /setTimeout\(\(\) => set(Copied|CopyFailed)\(false\), 2000\)/g,
      ),
    ).toHaveLength(2);
    expect(source.match(/return \(\) => clearTimeout\(t\)/g)).toHaveLength(2);
  });

  it("shares https://weather.mukoko.com/{slug}, else the current address", () => {
    expect(source).toContain('const BASE_URL = "https://weather.mukoko.com"');
    expect(source).toContain("`${BASE_URL}/${slug}`");
    expect(source).toContain("window.location.href");
  });
});
