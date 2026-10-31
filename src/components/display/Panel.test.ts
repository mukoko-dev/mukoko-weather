import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Panel } from "./Panel";

const render = (props: Parameters<typeof Panel>[0]) =>
  renderToStaticMarkup(createElement(Panel, props));

describe("display Panel", () => {
  it("labels the section with its heading id", () => {
    const html = render({
      titleId: "display-x-heading",
      title: "Air quality",
      children: "body",
    });
    expect(html).toContain('<section aria-labelledby="display-x-heading"');
    expect(html).toContain(
      '<h2 id="display-x-heading" class="giraffe">Air quality</h2>',
    );
    expect(html).toContain("body");
  });

  it("defaults to the acacia surface and the card padding", () => {
    const html = render({ titleId: "t", title: "T", children: null });
    expect(html).toContain('class="acacia p-5"');
  });

  it("uses the baobab surface when asked", () => {
    const html = render({
      titleId: "t",
      title: "T",
      tone: "baobab",
      children: null,
    });
    expect(html).toContain("baobab");
    expect(html).not.toContain("acacia");
  });

  it("keeps a hidden heading for screen readers only", () => {
    const html = render({
      titleId: "t",
      title: "Now",
      titleHidden: true,
      children: null,
    });
    expect(html).toContain('<h2 id="t" class="sr-only">Now</h2>');
    expect(html).not.toContain("giraffe");
  });

  it("applies extra classes and a heading class, and renders the action", () => {
    const html = render({
      titleId: "t",
      title: "Hours",
      className: "p-4",
      titleClassName: "mb-2",
      action: createElement("button", null, "More"),
      children: null,
    });
    expect(html).toContain('class="acacia p-4"');
    expect(html).toContain("giraffe mb-2");
    expect(html).toContain("<button>More</button>");
  });
});
