import { describe, it, expect } from "vitest";
import { MAP_LAYERS, DEFAULT_LAYER, getMapLayerById } from "./map-layers";

describe("MAP_LAYERS", () => {
  it("has at least 3 layers (issue requirement)", () => {
    expect(MAP_LAYERS.length).toBeGreaterThanOrEqual(3);
  });

  it("each layer has required fields", () => {
    for (const layer of MAP_LAYERS) {
      expect(layer.id).toBeTruthy();
      expect(layer.label).toBeTruthy();
      expect(layer.description).toBeTruthy();
      expect(layer.style).toBeDefined();
      expect(layer.style.bg).toBeTruthy();
      expect(layer.style.border).toBeTruthy();
      expect(layer.style.text).toBeTruthy();
      expect(layer.style.badge).toBeTruthy();
    }
  });

  it("has unique layer IDs", () => {
    const ids = MAP_LAYERS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes precipitationIntensity layer", () => {
    expect(MAP_LAYERS.some((l) => l.id === "precipitationIntensity")).toBe(true);
  });

  it("includes cloudCover layer", () => {
    expect(MAP_LAYERS.some((l) => l.id === "cloudCover")).toBe(true);
  });

  it("includes temperature layer", () => {
    expect(MAP_LAYERS.some((l) => l.id === "temperature")).toBe(true);
  });
});

describe("DEFAULT_LAYER", () => {
  it("is a valid layer ID", () => {
    expect(MAP_LAYERS.some((l) => l.id === DEFAULT_LAYER)).toBe(true);
  });
});

describe("getMapLayerById", () => {
  it("returns the layer for a valid ID", () => {
    const layer = getMapLayerById("precipitationIntensity");
    expect(layer).toBeDefined();
    expect(layer!.label).toBe("Rain");
  });

  it("returns undefined for an invalid ID", () => {
    expect(getMapLayerById("nonexistent")).toBeUndefined();
  });
});
