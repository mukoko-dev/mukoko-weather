/**
 * PageHeader is the one title block for ordinary pages: the h1 (`elephant`),
 * an optional intro (`gazelle`), an optional dimmed "updated" line, then any
 * children. Rendered for real with react-dom/server.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PageHeader } from "./PageHeader";

const render = (props: Parameters<typeof PageHeader>[0]) =>
  renderToStaticMarkup(createElement(PageHeader, props));

describe("PageHeader", () => {
  it("renders the title as the only h1, with the elephant class", () => {
    const html = render({ title: "Explore" });
    expect(html).toContain('<h1 class="elephant">Explore</h1>');
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("renders no intro or updated line when none is given", () => {
    const html = render({ title: "About" });
    expect(html).not.toContain("<p");
  });

  it("renders the intro as a gazelle paragraph", () => {
    const html = render({ title: "Help", intro: "Everything you need." });
    expect(html).toContain('<p class="gazelle mt-3">Everything you need.</p>');
  });

  it("renders the updated line dimmed, after the intro", () => {
    const html = render({
      title: "Privacy Policy",
      intro: "How we handle data.",
      updated: "Last updated: October 2026",
    });
    expect(html).toContain(
      '<p class="mt-2 text-base text-text-tertiary">Last updated: October 2026</p>',
    );
    expect(html.indexOf("How we handle data.")).toBeLessThan(
      html.indexOf("Last updated"),
    );
  });

  it("renders children last, after the intro and updated line", () => {
    const html = render({
      title: "Releases",
      intro: "Newest first.",
      children: createElement("span", null, "EXTRA"),
    });
    expect(html.indexOf("Newest first.")).toBeLessThan(html.indexOf("EXTRA"));
  });

  it("renders a JSX intro", () => {
    const html = render({
      title: "Embed",
      intro: createElement("strong", null, "Free"),
    });
    expect(html).toContain("<strong>Free</strong>");
  });
});
