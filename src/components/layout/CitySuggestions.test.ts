import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { canonicalSlug } from "@/lib/slug-migration";
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
    // A link to a shipped place is its canonical URL (#317).
    expect(html).toContain(`href="/${canonicalSlug("harare")}"`);
    expect(html).toContain(`href="/${canonicalSlug("nairobi-ke")}"`);
    expect(html).toContain(">Nairobi<");
  });

  it("renders nothing for an empty list", () => {
    expect(
      renderToString(createElement(CitySuggestions, { locations: [] })),
    ).toBe("");
  });
});
