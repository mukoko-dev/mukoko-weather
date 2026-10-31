import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MetricValue } from "./MetricValue";

const source = readFileSync(resolve(__dirname, "MetricValue.tsx"), "utf-8");

describe("MetricValue render", () => {
  it("renders the numeral as a paragraph with the large numeral chain", () => {
    const html = renderToStaticMarkup(createElement(MetricValue, null, "42"));
    expect(html).toBe(
      '<p class="font-heading text-4xl font-semibold leading-none tabular-nums text-text-primary">42</p>',
    );
  });

  it("renders an optional unit suffix", () => {
    const html = renderToStaticMarkup(
      MetricValue({ unit: "%", children: "63" }),
    );
    expect(html).toContain("63");
    expect(html).toContain(">%</span>");
  });

  it("uses tokens only", () => {
    expect(source).not.toContain("style={{");
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}[^)]/);
  });
});
