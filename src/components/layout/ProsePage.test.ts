/**
 * ProsePage and ProseSection are the shared body of the legal and information
 * pages: the title block with the "Last updated" line, the body wrapper, and
 * an eland-headed section. Rendered for real with react-dom/server.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProsePage, ProseSection } from "./ProsePage";

describe("ProsePage", () => {
  it("renders the title, the updated line and the body wrapper", () => {
    const html = renderToStaticMarkup(
      createElement(
        ProsePage,
        {
          title: "Terms of Service",
          updated: "Last updated: June 2026",
        },
        createElement("p", null, "Body"),
      ),
    );
    expect(html).toContain('<h1 class="elephant">Terms of Service</h1>');
    expect(html).toContain("Last updated: June 2026");
    expect(html).toContain(
      '<div class="mt-8 space-y-8 text-text-secondary leading-relaxed"><p>Body</p></div>',
    );
  });

  it("omits the updated line when no date is given", () => {
    const html = renderToStaticMarkup(
      createElement(
        ProsePage,
        {
          title: "Hi",
        },
        createElement("p", null, "x"),
      ),
    );
    expect(html).not.toContain("Last updated");
  });
});

describe("ProseSection", () => {
  it("renders an eland heading then its body inside a section", () => {
    const html = renderToStaticMarkup(
      createElement(
        ProseSection,
        {
          heading: "1. Agreement",
        },
        createElement("p", null, "Text"),
      ),
    );
    expect(html).toBe(
      '<section><h2 class="eland">1. Agreement</h2><p>Text</p></section>',
    );
  });

  it("takes a section class when given", () => {
    const html = renderToStaticMarkup(
      createElement(
        ProseSection,
        {
          heading: "H",
          className: "mt-10",
        },
        null,
      ),
    );
    expect(html).toContain('<section class="mt-10">');
  });
});
