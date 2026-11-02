import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FLOATING_CARD_CLASS, FloatingStack } from "./floating-stack";

describe("FloatingStack: floating cards share one column above the mobile nav", () => {
  const html = renderToStaticMarkup(
    createElement(
      FloatingStack,
      null,
      createElement("section", { key: "a" }, "location ask"),
      createElement("section", { key: "b" }, "load notice"),
    ),
  );

  it("is one fixed column that clears the mobile nav and its safe area, and drops to the bottom edge on sm+", () => {
    expect(html).toContain("fixed inset-x-3");
    expect(html).toContain("bottom-[var(--mobile-nav-clearance)]");
    expect(html).toContain("sm:bottom-6");
    expect(html).toContain("z-30");
    expect(html).toContain("max-w-md");
  });

  it("stacks its cards, in reading order (the last is the lowest), instead of laying them on top of each other", () => {
    expect(html).toMatch(/\bflex\b[^"]*\bflex-col\b[^"]*\bgap-2\b/);
    // DOM order is visual order: no reversed flow for tab and screen-reader order to disagree with.
    expect(html).not.toContain("flex-col-reverse");
    // The cards are in the flow of the column, not fixed themselves.
    expect(FLOATING_CARD_CLASS).not.toMatch(/\bfixed\b|\babsolute\b/);
  });

  it("holds both cards", () => {
    expect(html.indexOf("location ask")).toBeLessThan(
      html.indexOf("load notice"),
    );
  });

  it("the card surface is tokens only", () => {
    expect(FLOATING_CARD_CLASS).toContain("rounded-[var(--radius-card)]");
    expect(FLOATING_CARD_CLASS).toContain("bg-surface-card/95");
    expect(FLOATING_CARD_CLASS).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
