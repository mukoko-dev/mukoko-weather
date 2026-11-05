/**
 * Tests for the bottom-sheet layer chips (WeatherLayerPanel).
 * Node-env structural checks (no DOM renderer): the chips must be labelled,
 * drawn from MAP_CHIPS, and sized from the touch-target token.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Flame, Layers } from "lucide-react";
import {
  MAP_CHIPS,
  AIR_QUALITY_LAYER_ID,
  WILDFIRE_LAYER_ID,
} from "@/lib/map-layers";
import { CHIP_ICONS, chipIcon, scrollChipIntoView } from "./WeatherLayerPanel";

const panelSource = readFileSync(
  resolve(__dirname, "WeatherLayerPanel.tsx"),
  "utf-8",
);

describe("WeatherLayerPanel — labelled chips", () => {
  it("renders chip labels from MAP_CHIPS (or the chips it is given); icons are decorative, never icon-only", () => {
    expect(panelSource).toContain("chips = MAP_CHIPS");
    expect(panelSource).toContain("chips.map");
    expect(panelSource).toContain("{chip.label}");
    expect(panelSource).toContain(
      '<LayerIcon id={chip.id} className="h-4 w-4" />',
    );
    expect(panelSource).toContain('"aria-hidden": true');
  });

  it("has an icon for every shipped chip, and a generic fallback for new layers", () => {
    for (const chip of MAP_CHIPS) {
      expect(CHIP_ICONS[chip.id]).toBeDefined();
    }
    expect(chipIcon("some-future-layer")).toBe(Layers);
  });

  it("scrolls sideways with an edge fade, in both rows, so more layers fit", () => {
    expect(panelSource.match(/scroll-fade-x/g)).toHaveLength(2);
    expect(panelSource).toContain("overflow-x-auto");
  });

  it("scrolls a focused chip fully into its row (the browser leaves a half-visible one under the fade)", () => {
    // Both rows: the layer chips and the model chips.
    expect(panelSource.match(/onFocus=\{scrollChipIntoView\}/g)).toHaveLength(
      2,
    );
    const calls: unknown[] = [];
    const event = {
      currentTarget: { scrollIntoView: (o: unknown) => calls.push(o) },
    } as unknown as Parameters<typeof scrollChipIntoView>[0];
    scrollChipIntoView(event);
    // Sideways only: never moves the sheet up or down.
    expect(calls).toEqual([
      { inline: "nearest", block: "nearest", behavior: "smooth" },
    ]);
  });

  it("keeps a chip clear of the edge fade, scrolled to the end or reached by keyboard focus", () => {
    // The fade is 1.5rem wide at the end (.scroll-fade-x in globals.css).
    // scroll-px-6 is the same 1.5rem of scroll padding for a chip focus
    // scrolls into view, and pe-6 the same 1.5rem of padding after the last
    // chip (now Wildfires), so neither leaves it half under the fade.
    expect(panelSource.match(/scroll-px-6/g)).toHaveLength(2);
    expect(panelSource.match(/ps-4 pe-6/g)).toHaveLength(2);
    const css = readFileSync(
      resolve(__dirname, "../../../app/globals.css"),
      "utf-8",
    );
    expect(css).toMatch(/\.scroll-fade-x \{[^}]*#000 calc\(100% - 1\.5rem\)/);
  });

  it("offers the five chips the brief asks for, then the NASA satellite layers and wildfires, in order", () => {
    expect(MAP_CHIPS.map((c) => c.label)).toEqual([
      "Air quality",
      "Rain",
      "Temperature",
      "Wind",
      "Cloud",
      "Satellite",
      "Rain (satellite)",
      "Wildfires",
    ]);
    expect(MAP_CHIPS[0].id).toBe(AIR_QUALITY_LAYER_ID);
  });

  it("draws the Wildfires chip with the Lucide flame, next to its text label", () => {
    expect(CHIP_ICONS[WILDFIRE_LAYER_ID]).toBe(Flame);
    expect(chipIcon("wildfire")).toBe(Flame);
    expect(MAP_CHIPS.find((c) => c.id === WILDFIRE_LAYER_ID)!.label).toBe(
      "Wildfires",
    );
  });

  it("is single-select: aria-pressed marks the active chip only", () => {
    expect(panelSource).toContain("aria-pressed={isActive}");
    expect(panelSource).toContain('role="group"');
  });
});

describe("WeatherLayerPanel — touch targets", () => {
  it("uses the shared .quail chip, which carries the 48px touch-target minimum", () => {
    expect(panelSource).toContain('"quail inline-flex shrink-0');
    expect(panelSource).toContain('"quail shrink-0');
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

describe("WeatherLayerPanel — model picker", () => {
  it("renders a labelled model row only when models are passed", () => {
    expect(panelSource).toContain(
      "if (!models || models.length === 0 || !onModelChange) return chipRow;",
    );
    expect(panelSource).toContain('aria-label="Forecast model"');
    expect(panelSource).toContain("{model.label}");
  });

  it("reuses the chip control class for model chips (text only, no restyle)", () => {
    const quail =
      panelSource.match(/"quail shrink-0 px-4 text-sm font-medium"/g) ?? [];
    expect(quail).toHaveLength(1);
  });
});
