import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FROST_BANNER_CLASSES, type FrostRisk } from "@/lib/frost-styles";
import { FrostAlertBanner } from "./FrostAlertBanner";

/**
 * Frost banner colours are blues from the weather-scale tokens (not brand
 * minerals, not the red severity ramp).
 */
const RISKS: FrostRisk[] = ["moderate", "high", "severe"];

describe("FrostAlertBanner CSS class mapping", () => {
  it("maps each risk to a frost-scale blue, light to dark", () => {
    expect(FROST_BANNER_CLASSES.moderate.border).toBe("border-wx-frost-1");
    expect(FROST_BANNER_CLASSES.high.border).toBe("border-wx-frost-2");
    expect(FROST_BANNER_CLASSES.severe.border).toBe("border-wx-frost-3");
  });

  it("never uses hex, rgba, mineral or red severity classes", () => {
    for (const risk of RISKS) {
      const classes = Object.values(FROST_BANNER_CLASSES[risk]).join(" ");
      expect(classes).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(classes).not.toMatch(/rgba?\(/);
      expect(classes).not.toMatch(/mineral|severity|frost-severe|earth|accent/);
    }
  });

  it("the component reads the shared map", () => {
    const source = readFileSync(
      join(__dirname, "FrostAlertBanner.tsx"),
      "utf8",
    );
    expect(source).toContain("FROST_BANNER_CLASSES[alert.risk]");
  });
});

describe("FrostAlertBanner can be closed", () => {
  const render = (risk: FrostRisk, className?: string) =>
    renderToStaticMarkup(
      createElement(FrostAlertBanner, {
        alert: { risk, message: "Frost likely before dawn." } as never,
        className,
      }),
    );

  it("names its close button for what it closes", () => {
    expect(render("severe")).toContain('aria-label="Dismiss frost warning"');
    expect(render("moderate")).toContain('aria-label="Dismiss frost advisory"');
  });

  it("keeps the assertive live region, the title and the message, and leaves room for the button", () => {
    const html = render("high");
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain("Frost Advisory — HIGH");
    expect(html).toContain("Frost likely before dawn.");
    expect(html).toContain("pr-12");
  });

  it("leaves a gap below it unless the page spaces its stack itself", () => {
    expect(render("high")).toContain("mb-7");
    expect(render("high", "")).not.toContain("mb-7");
  });

  it("is a different message for a different risk, so a closed advisory does not hide a warning", () => {
    const source = readFileSync(
      join(__dirname, "FrostAlertBanner.tsx"),
      "utf8",
    );
    expect(source).toContain("id={`frost:${alert.risk}:${alert.message}`}");
    expect(source).toContain('remember="session"');
  });
});
