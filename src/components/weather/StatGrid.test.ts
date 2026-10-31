import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatGrid } from "./StatGrid";

const source = readFileSync(resolve(__dirname, "StatGrid.tsx"), "utf-8");

describe("StatGrid render", () => {
  it("renders each item as a dt/dd pair inside a meerkat tile", () => {
    const html = renderToStaticMarkup(
      createElement(StatGrid, {
        items: [
          { label: "Visibility", value: "10 km" },
          { label: "PM2.5", value: "12 µg/m³", hint: "hourly" },
        ],
      }),
    );
    expect(html.startsWith("<dl")).toBe(true);
    expect(html.match(/class="meerkat"/g)?.length).toBe(2);
    expect(html).toContain("<dt");
    expect(html).toContain("Visibility");
    expect(html).toContain('<span class="dove block">hourly</span>');
  });

  it("maps column counts to literal grid classes", () => {
    const html = renderToStaticMarkup(
      createElement(StatGrid, {
        items: [{ label: "A", value: "1" }],
        columns: 4,
      }),
    );
    expect(html).toContain("sm:grid-cols-4");
  });

  it("uses tokens only, no inline styles or hardcoded colours", () => {
    expect(source).not.toContain("style={{");
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}[^)]/);
    expect(source).not.toMatch(/rgba?\(/);
  });
});
