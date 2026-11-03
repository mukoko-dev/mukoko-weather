import { createElement } from "react";
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Field, FIELD_CONTROL_CLASS } from "./field";

const input = createElement("input", null);

describe("Field", () => {
  it("associates the label with its control by id", () => {
    const html = renderToStaticMarkup(
      Field({
        label: "First name",
        htmlFor: "first",
        children: createElement("input", { id: "first" }),
      }),
    );
    expect(html).toContain('<label for="first"');
    expect(html).toContain("First name");
    expect(html).toContain('<input id="first"');
  });

  it("renders the hint between the label and the control", () => {
    const html = renderToStaticMarkup(
      Field({
        label: "Key",
        hint: "Shown once",
        children: input,
      }),
    );
    const labelAt = html.indexOf("Key");
    const hintAt = html.indexOf("Shown once");
    const inputAt = html.indexOf("<input");
    expect(labelAt).toBeLessThan(hintAt);
    expect(hintAt).toBeLessThan(inputAt);
  });

  it("omits the hint when none is given", () => {
    const html = renderToStaticMarkup(Field({ label: "Key", children: input }));
    expect(html).not.toContain("<p");
  });

  it("replaces the default label class when asked", () => {
    const html = renderToStaticMarkup(
      Field({
        label: "Search",
        labelClassName: "sr-only",
        children: input,
      }),
    );
    expect(html).toContain('class="sr-only"');
    expect(html).not.toContain("font-medium");
  });

  it("uses the shared control class (fauna input, touch-target height)", () => {
    expect(FIELD_CONTROL_CLASS).toBe(
      "crane mt-1 min-h-[var(--touch-target-min)]",
    );
  });
});
