import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SelectRow } from "./SelectRow";

const render = (selected: boolean) =>
  renderToStaticMarkup(
    SelectRow({
      selected,
      onSelect: () => {},
      children: createElement("span", null, "Dark"),
    }),
  );

describe("SelectRow", () => {
  it("is a radio button using the bushbuck surface", () => {
    const html = render(false);
    expect(html).toContain('role="radio"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("bushbuck");
    expect(html).not.toContain("data-active");
    expect(html).not.toContain("polyline");
  });

  it("marks the selected row with data-active and a check mark", () => {
    const html = render(true);
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('data-active="true"');
    expect(html).toContain("polyline");
  });

  it("keeps the 48px touch-target minimum via the bushbuck class", () => {
    expect(render(false)).toContain("bushbuck");
  });
});
