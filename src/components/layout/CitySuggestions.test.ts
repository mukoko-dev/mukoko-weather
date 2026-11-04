import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CitySuggestions } from "./CitySuggestions";

describe("CitySuggestions", () => {
  it("lists each place as a link to its page", () => {
    const html = renderToString(
      createElement(CitySuggestions, {
        locations: [
          { slug: "harare", name: "Harare" },
          { slug: "nairobi-ke", name: "Nairobi" },
        ],
      }),
    );
    expect(html).toContain("Try one of these cities:");
    expect(html).toContain('href="/harare"');
    expect(html).toContain(">Nairobi<");
  });

  it("renders nothing for an empty list", () => {
    expect(
      renderToString(createElement(CitySuggestions, { locations: [] })),
    ).toBe("");
  });
});
