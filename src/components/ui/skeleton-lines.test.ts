import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SkeletonLines } from "./skeleton";

describe("SkeletonLines", () => {
  it("is a labelled status region with one hidden pulse bar per line", () => {
    const html = renderToStaticMarkup(
      createElement(SkeletonLines, { count: 3 }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Loading"');
    expect(html.match(/animate-pulse/g)?.length).toBe(3);
    expect(html.match(/aria-hidden="true"/g)?.length).toBe(3);
  });

  it("uses the last-line width for the final bar", () => {
    const html = renderToStaticMarkup(
      createElement(SkeletonLines, { count: 2, lastWidth: "w-1/2" }),
    );
    expect(html).toContain("w-1/2");
    expect(html).toContain("w-full");
  });

  it("takes explicit per-line widths", () => {
    const html = renderToStaticMarkup(
      createElement(SkeletonLines, { widths: ["w-3/4", "w-full", "w-2/3"] }),
    );
    expect(html.match(/animate-pulse/g)?.length).toBe(3);
    expect(html).toContain("w-3/4");
    expect(html).toContain("w-2/3");
  });
});
