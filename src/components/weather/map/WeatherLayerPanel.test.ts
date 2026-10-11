/**
 * Tests for the bottom-sheet layer chips (WeatherLayerPanel).
 * Node-env structural checks (no DOM renderer): the chips must be labelled,
 * drawn from MAP_CHIPS, and sized from the touch-target token.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Layers } from "lucide-react";
import { MAP_CHIPS, AIR_QUALITY_LAYER_ID } from "@/lib/map-layers";
import { CHIP_ICONS, chipIcon } from "./WeatherLayerPanel";

const panelSource = readFileSync(
  resolve(__dirname, "WeatherLayerPanel.tsx"),
  "utf-8",
);

describe("WeatherLayerPanel — labelled chips", () => {
  it("renders chip labels from MAP_CHIPS; icons are decorative, never icon-only", () => {
    expect(panelSource).toContain("MAP_CHIPS.map");
    expect(panelSource).toContain("{chip.label}");
    expect(panelSource).toContain(
      '<LayerIcon id={chip.id} className="h-4 w-4" />',
    );
  });

  it("has an icon for every chip, and a generic fallback for new layers", () => {
    for (const chip of MAP_CHIPS) {
      expect(CHIP_ICONS[chip.id]).toBeDefined();
    }
    expect(chipIcon("some-future-layer")).toBe(Layers);
    expect(panelSource).toContain('"aria-hidden": true');
  });

  it("scrolls sideways with an edge fade so more layers fit", () => {
    expect(panelSource).toContain("overflow-x-auto");
    expect(panelSource).toContain("scroll-fade-x");
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
  it("uses the shared .quail chip, which carries the 48px touch-target minimum", () => {
    expect(panelSource).toContain('"quail inline-flex shrink-0');
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
