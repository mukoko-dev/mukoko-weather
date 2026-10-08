/**
 * Tests for the bottom-sheet layer chips (WeatherLayerPanel).
 * Node-env structural checks (no DOM renderer): the chips must be labelled,
 * drawn from MAP_CHIPS, and sized from the touch-target token.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { MAP_CHIPS, AIR_QUALITY_LAYER_ID } from "@/lib/map-layers";

const panelSource = readFileSync(
  resolve(__dirname, "WeatherLayerPanel.tsx"),
  "utf-8",
);

describe("WeatherLayerPanel — labelled chips", () => {
  it("renders chip labels from MAP_CHIPS, not icons", () => {
    expect(panelSource).toContain("MAP_CHIPS.map");
    expect(panelSource).toContain("{chip.label}");
    expect(panelSource).not.toContain("lucide-react");
  });

  it("offers exactly the five chips the brief asks for, in order", () => {
    expect(MAP_CHIPS.map((c) => c.label)).toEqual([
      "Air quality",
      "Rain",
      "Temperature",
      "Wind",
      "Cloud",
    ]);
    expect(MAP_CHIPS[0].id).toBe(AIR_QUALITY_LAYER_ID);
  });

  it("is single-select: aria-pressed marks the active chip only", () => {
    expect(panelSource).toContain("aria-pressed={isActive}");
    expect(panelSource).toContain('role="group"');
  });
});

describe("WeatherLayerPanel — touch targets", () => {
  it("sizes each chip to the 48px touch-target minimum", () => {
    expect(panelSource).toContain("min-h-[var(--touch-target-min)]");
  });

  it("uses no hardcoded sizes", () => {
    expect(panelSource).not.toMatch(/h-10 w-10|h-\[44px\]|h-11/);
  });

  it("does not use the old duplicate switcher component", () => {
    expect(() =>
      readFileSync(resolve(__dirname, "MapLayerSwitcher.tsx"), "utf-8"),
    ).toThrow();
  });
});
