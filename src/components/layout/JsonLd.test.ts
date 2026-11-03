import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JsonLd } from "./JsonLd";

function render(data: unknown): string {
  return renderToStaticMarkup(createElement(JsonLd, { data }));
}

describe("JsonLd", () => {
  it("renders a ld+json script that parses back to the data", () => {
    const html = render([{ "@type": "Place", name: "Harare" }]);
    expect(html).toMatch(/^<script type="application\/ld\+json">/);
    // The element's text is whatever sits between the first ">" and the last "</".
    const body = html.slice(html.indexOf(">") + 1, html.lastIndexOf("</"));
    expect(JSON.parse(body)).toEqual([{ "@type": "Place", name: "Harare" }]);
  });

  it("escapes a script-breaking name the same way safeJsonLd does", () => {
    const html = render({ name: "</script><b>x</b>" });
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).not.toContain("<b>");
  });
});
