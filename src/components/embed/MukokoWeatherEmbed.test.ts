import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Tests for MukokoWeatherEmbed — validates the four supported embed variants,
 * the self-contained CSS module (no inline styles / hardcoded colors in the
 * component), and that the widget talks to the public embed API.
 */

const cssModulePath = resolve(__dirname, "./MukokoWeatherEmbed.module.css");
const cssContent = readFileSync(cssModulePath, "utf-8");

const componentPath = resolve(__dirname, "./MukokoWeatherEmbed.tsx");
const componentContent = readFileSync(componentPath, "utf-8");

describe("MukokoWeatherEmbed CSS module", () => {
  it("defines light theme custom properties in .widget", () => {
    expect(cssContent).toContain(".widget");
    expect(cssContent).toContain("--mkw-bg");
    expect(cssContent).toContain("--mkw-text");
    expect(cssContent).toContain("--mkw-primary");
    expect(cssContent).toContain("--mkw-border");
  });

  it("defines dark theme overrides in .widgetDark", () => {
    expect(cssContent).toContain(".widgetDark");
  });

  it("defines styles for all four widget variants", () => {
    expect(cssContent).toContain(".currentCard");
    expect(cssContent).toContain(".todayCard");
    expect(cssContent).toContain(".forecastCard");
  });

  it("uses CSS custom properties for colors, not hardcoded values", () => {
    const propertyDeclarations = cssContent
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return (
          trimmed.includes(":") &&
          !trimmed.startsWith("--") &&
          !trimmed.startsWith("/*") &&
          !trimmed.startsWith("*")
        );
      });

    const colorProps = propertyDeclarations.filter(
      (line) =>
        /\b(color|background|border-top|border-bottom)\b/.test(line) &&
        !line.includes("composes"),
    );

    for (const prop of colorProps) {
      if (prop.includes("var(--mkw-")) continue;
      if (/:\s*none/.test(prop)) continue;
      if (prop.includes("var(")) continue;
      expect(prop).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    }
  });
});

describe("MukokoWeatherEmbed component", () => {
  it("imports the CSS module", () => {
    expect(componentContent).toContain(
      'import styles from "./MukokoWeatherEmbed.module.css"',
    );
  });

  it("does not use inline style objects", () => {
    expect(componentContent).not.toMatch(/style=\{\{/);
  });

  it("supports exactly the four documented variants", () => {
    expect(componentContent).toContain('"current" | "today" | "5day" | "7day"');
    expect(componentContent).toContain('type === "today"');
    expect(componentContent).toContain('type === "5day"');
    expect(componentContent).toContain('type === "7day"');
  });

  it("no longer supports the removed badge / forecast variants", () => {
    expect(componentContent).not.toContain('type === "badge"');
    expect(componentContent).not.toContain('type === "forecast"');
  });

  it("calls the public embed API", () => {
    expect(componentContent).toContain("/api/embed/current");
  });

  it("defaults to IP-based weather when no location is configured", () => {
    // When no slug/lat/lon, the query string is empty → API derives from IP.
    expect(componentContent).toContain("if (location)");
    expect(componentContent).toContain('qs.set("slug", location)');
  });

  it("uses styles.* for the variant class names", () => {
    expect(componentContent).toContain("styles.currentCard");
    expect(componentContent).toContain("styles.todayCard");
    expect(componentContent).toContain("styles.forecastCard");
  });

  it("is re-exported from the embed barrel for external consumers", () => {
    const indexContent = readFileSync(resolve(__dirname, "./index.ts"), "utf-8");
    expect(indexContent).toContain(
      'export { MukokoWeatherEmbed } from "./MukokoWeatherEmbed"',
    );
    expect(indexContent).toContain('export type { EmbedType }');
  });
});

describe("MukokoWeatherEmbed consumers", () => {
  it("is rendered by the standalone iframe widget route", () => {
    const widgetPage = readFileSync(
      resolve(__dirname, "../../app/embed/widget/page.tsx"),
      "utf-8",
    );
    expect(widgetPage).toContain('from "@/components/embed"');
    expect(widgetPage).toContain("<MukokoWeatherEmbed");
  });

  it("powers the live preview on the /embed docs page", () => {
    const docsPage = readFileSync(
      resolve(__dirname, "../../app/embed/page.tsx"),
      "utf-8",
    );
    expect(docsPage).toContain("MukokoWeatherEmbed");
    // The docs page leads with a copy-paste iframe pointing at the widget route.
    expect(docsPage).toContain("/embed/widget?type=");
    // The broken npm import must NOT be presented as usable.
    expect(docsPage).not.toContain(
      'import { MukokoWeatherEmbed } from "@mukoko/weather-embed"',
    );
  });
});
