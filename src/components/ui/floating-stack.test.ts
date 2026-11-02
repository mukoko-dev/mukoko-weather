import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FLOATING_CARD_CLASS, FloatingStack } from "./floating-stack";

describe("FloatingStack: floating cards share one column above the mobile nav", () => {
  const html = renderToStaticMarkup(
    createElement(
      FloatingStack,
      null,
      createElement("section", { key: "a" }, "load notice"),
      createElement("section", { key: "b" }, "location ask"),
    ),
  );

  it("is one fixed column that clears the mobile nav and its safe area, and drops to the bottom edge on sm+", () => {
    expect(html).toContain("fixed inset-x-3");
    expect(html).toContain("bottom-[var(--mobile-nav-clearance)]");
    expect(html).toContain("sm:bottom-6");
    expect(html).toContain("z-30");
    expect(html).toContain("max-w-md");
  });

  it("stacks its cards (the first is the lowest) instead of laying them on top of each other", () => {
    expect(html).toContain("flex-col-reverse");
    expect(html).toContain("gap-2");
    // The cards are in the flow of the column, not fixed themselves.
    expect(FLOATING_CARD_CLASS).not.toMatch(/\bfixed\b|\babsolute\b/);
  });

  it("holds both cards", () => {
    expect(html.indexOf("load notice")).toBeLessThan(
      html.indexOf("location ask"),
    );
  });

  it("the card surface is tokens only", () => {
    expect(FLOATING_CARD_CLASS).toContain("rounded-[var(--radius-card)]");
    expect(FLOATING_CARD_CLASS).toContain("bg-surface-card/95");
    expect(FLOATING_CARD_CLASS).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
