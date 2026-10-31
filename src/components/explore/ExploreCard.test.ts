/**
 * ExploreCard is the one link card for explore locations, provinces and
 * countries. Rendered for real with react-dom/server.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExploreCard } from "./ExploreCard";
import { CountPill } from "./CountPill";
import { TagPill } from "./TagPill";
import { readFileSync } from "fs";
import { resolve } from "path";

const render = (props: Parameters<typeof ExploreCard>[0]) =>
  renderToStaticMarkup(createElement(ExploreCard, props));

describe("ExploreCard", () => {
  it("is a link to href on the baobab card surface", () => {
    const html = render({ href: "/harare", title: "Harare" });
    expect(html).toContain('href="/harare"');
    expect(html.startsWith("<a ")).toBe(true);
    expect(html).toContain("card-interactive baobab");
  });

  it("renders the title as a span by default", () => {
    const html = render({ href: "/x", title: "Harare" });
    expect(html).toContain("<span");
    expect(html).toContain(">Harare</span>");
    expect(html).not.toMatch(/<h[23]/);
  });

  it("renders the title as a heading when as is given", () => {
    const html = render({ href: "/x", title: "Mining", as: "h3" });
    expect(html).toMatch(/<h3 class="giraffe[^"]*">Mining<\/h3>/);
  });

  it("renders the meta line and the badge", () => {
    const html = render({
      href: "/x",
      title: "Harare",
      meta: "1490m elevation",
      badge: createElement(TagPill, null, "city"),
    });
    expect(html).toContain("1490m elevation");
    expect(html).toContain(">city</span>");
  });

  it("renders children last", () => {
    const html = render({
      href: "/x",
      title: "Harare",
      children: createElement("p", null, "Tail"),
    });
    expect(html.indexOf("Tail")).toBeGreaterThan(html.indexOf("Harare"));
  });

  it("uses no hardcoded colours or inline styles", () => {
    const src = readFileSync(resolve(__dirname, "ExploreCard.tsx"), "utf-8");
    expect(src).not.toContain("style={{");
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});

describe("CountPill", () => {
  it("renders its number in the primary-tinted pill", () => {
    const html = renderToStaticMarkup(createElement(CountPill, null, 12));
    expect(html).toContain("rounded-full bg-primary/10");
    expect(html).toContain(">12</span>");
  });
});

describe("TagPill", () => {
  it("renders the tag in the primary-tinted pill", () => {
    const html = renderToStaticMarkup(createElement(TagPill, null, "farming"));
    expect(html).toContain("bg-primary/10");
    expect(html).toContain(">farming</span>");
  });
});
