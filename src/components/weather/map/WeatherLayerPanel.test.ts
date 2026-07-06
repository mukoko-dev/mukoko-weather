/**
 * Tests for the compact overlay layer switcher (WeatherLayerPanel).
 * Node-env structural checks (no DOM renderer) — read the component source and
 * assert every configured layer resolves to a lucide icon, plus that the map
 * route places the switcher bottom-RIGHT.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { MAP_LAYERS } from "@/lib/map-layers";

const panelSource = readFileSync(
  resolve(__dirname, "WeatherLayerPanel.tsx"),
  "utf-8",
);
const dashboardSource = readFileSync(
  resolve(__dirname, "../../../app/[location]/map/MapDashboard.tsx"),
  "utf-8",
);

describe("WeatherLayerPanel — icon per layer (item 3)", () => {
  it("imports and registers a lucide icon for EVERY configured layer", () => {
    // The registry keys are the MapLayer.icon names; the icons are imported
    // from lucide-react. If a layer's icon is missing here it would fall back
    // silently, so assert every one is present in both the import and registry.
    for (const layer of MAP_LAYERS) {
      expect(panelSource).toContain(layer.icon);
    }
  });

  it("includes the Cloud icon (the cloud layer was previously iconless)", () => {
    expect(panelSource).toContain('from "lucide-react"');
    expect(panelSource).toMatch(/LAYER_ICONS[\s\S]*Cloud/);
    const cloud = MAP_LAYERS.find((l) => l.id === "cloudCover");
    expect(cloud!.icon).toBe("Cloud");
  });

  it("renders an <Icon> for each layer button with a safe fallback", () => {
    expect(panelSource).toContain(
      "const Icon = LAYER_ICONS[layer.icon] ?? Cloud",
    );
    expect(panelSource).toContain("<Icon");
  });
});

describe("MapDashboard — switcher placement (item 4)", () => {
  it("positions the overlay switcher on the RIGHT, not the left", () => {
    expect(dashboardSource).toContain("<WeatherLayerPanel");
    expect(dashboardSource).toContain("right-3");
    expect(dashboardSource).not.toContain("bottom-6 left-3");
  });
});

describe("WeatherLayerPanel — touch targets (issue #96)", () => {
  it("sizes every layer button from the touch-target token, not hardcoded h-10/w-10", () => {
    expect(panelSource).toContain("h-[var(--touch-target-min)]");
    expect(panelSource).toContain("w-[var(--touch-target-min)]");
    expect(panelSource).not.toContain("h-10 w-10");
  });

  it("the duplicate MapLayerSwitcher component is gone (WeatherLayerPanel is canonical)", () => {
    expect(() =>
      readFileSync(resolve(__dirname, "MapLayerSwitcher.tsx"), "utf-8"),
    ).toThrow();
  });
});
