import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Tests for MukokoWeatherEmbed CSS module.
 * Validates that the embed widget uses CSS custom properties via a module
 * instead of inline styles with hardcoded values.
 */

// Read the CSS module file content for validation
const cssModulePath = resolve(__dirname, "./MukokoWeatherEmbed.module.css");
const cssContent = readFileSync(cssModulePath, "utf-8");

// Read the component file content
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

  it("defines styles for all widget types", () => {
    expect(cssContent).toContain(".currentCard");
    expect(cssContent).toContain(".forecastCard");
    expect(cssContent).toContain(".badge");
  });

  it("uses CSS custom properties for colors, not hardcoded values", () => {
    // Extract all property declarations (not custom property definitions)
    const propertyDeclarations = cssContent
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        // Skip custom property definitions (--mkw-*) and comments
        return (
          trimmed.includes(":") &&
          !trimmed.startsWith("--") &&
          !trimmed.startsWith("/*") &&
          !trimmed.startsWith("*")
        );
      });

    // Color-related properties should reference var(--mkw-*) not hardcoded colors
    const colorProps = propertyDeclarations.filter((line) =>
      /\b(color|background|border-top|border-bottom)\b/.test(line) &&
      !line.includes("composes")
    );

    for (const prop of colorProps) {
      // Must use var(--mkw-*) for color values
      if (prop.includes("var(--mkw-")) continue;
      // "none" is acceptable for border-bottom
      if (/:\s*none/.test(prop)) continue;
      // border shorthand with var() is fine
      if (prop.includes("var(")) continue;
      // Fail if there's a raw hex or rgb color
      expect(prop).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    }
  });
});

describe("MukokoWeatherEmbed component", () => {
  it("imports the CSS module", () => {
    expect(componentContent).toContain('import styles from "./MukokoWeatherEmbed.module.css"');
  });

  it("does not use inline style objects", () => {
    // The component should not have style={{...}} patterns
    expect(componentContent).not.toMatch(/style=\{\{/);
  });

  it("uses styles.* for class names", () => {
    expect(componentContent).toContain("styles.widget");
    expect(componentContent).toContain("styles.currentCard");
    expect(componentContent).toContain("styles.forecastCard");
    expect(componentContent).toContain("styles.badge");
  });
});
