import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SeasonBadge } from "./SeasonBadge";

const season = {
  name: "Spring",
  localName: "Chirimo",
  description: "Hot and dry before the rains",
};

describe("SeasonBadge", () => {
  it("shows the local name first, then the English name and description", () => {
    const html = renderToStaticMarkup(createElement(SeasonBadge, { season }));
    expect(html).toContain("Chirimo");
    expect(html).toContain("Spring — Hot and dry before the rains");
  });

  it("shows the plain name when there is no distinct local name", () => {
    const html = renderToStaticMarkup(
      createElement(SeasonBadge, {
        season: { ...season, localName: "Spring" },
      }),
    );
    expect(html).toContain("Hot and dry before the rains");
    expect(html).not.toContain("Spring — ");
  });

  it("wraps instead of truncating, so larger text sizes never cut it off", () => {
    const src = readFileSync(resolve(__dirname, "SeasonBadge.tsx"), "utf-8");
    expect(src).not.toMatch(/truncate|line-clamp/);
    expect(src).toContain("flex-wrap");
  });
});
