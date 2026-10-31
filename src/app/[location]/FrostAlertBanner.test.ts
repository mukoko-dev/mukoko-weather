import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FROST_BANNER_CLASSES, type FrostRisk } from "@/lib/frost-styles";

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
