import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProfileGroup } from "./ProfileGroup";

describe("ProfileGroup", () => {
  it("labels the section with its heading and wraps children in one card", () => {
    const html = renderToStaticMarkup(
      ProfileGroup({
        id: "g-heading",
        title: "Devices",
        children: createElement("p", null, "row"),
      }),
    );
    expect(html).toContain(
      '<section aria-labelledby="g-heading" class="guineafowl">',
    );
    expect(html).toContain(
      '<h2 id="g-heading" class="guineafowl-heading">Devices</h2>',
    );
    expect(html).toContain('<div class="guineafowl-card"><p>row</p></div>');
  });

  it("adds extra card classes", () => {
    const html = renderToStaticMarkup(
      ProfileGroup({
        id: "x",
        title: "Appearance",
        cardClassName: "p-3",
        children: null,
      }),
    );
    expect(html).toContain('class="guineafowl-card p-3"');
  });
});
