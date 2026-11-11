/**
 * useLayerCapacity (#542), what can be checked without a browser: the first
 * render. The probe's own rules (one request, the minute, the floor) are in
 * src/lib/map-capacity.test.ts; the swap itself is capacityState, tested
 * there. Here: which layers ask at all, and what the first frame holds back.
 * Effects do not run in a server render, so the probe is never called here,
 * which is itself the point for the default layer.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CapacityProbe } from "@/lib/map-capacity";
import { DEFAULT_LAYER } from "@/lib/map-layers";
import { useLayerCapacity, type LayerCapacity } from "./use-layer-capacity";

function firstRender(layer: string): {
  state: LayerCapacity;
  check: ReturnType<typeof vi.fn>;
} {
  const check = vi.fn();
  const probe: CapacityProbe = { check };
  let state!: LayerCapacity;
  function Probe() {
    state = useLayerCapacity({
      layer,
      lat: -17.83,
      lon: 31.05,
      mapZoom: 8,
      probe,
    });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return { state, check };
}

describe("useLayerCapacity, first render", () => {
  it("holds a Tomorrow.io layer's overlay back until one tile has answered", () => {
    for (const layer of [
      "precipitationIntensity",
      "temperature",
      "windSpeed",
      "cloudCover",
    ]) {
      const { state } = firstRender(layer);
      expect(state).toMatchObject({
        layer,
        held: true,
        busy: false,
        rechecking: false,
      });
    }
  });

  it("never holds, swaps or asks about the default layer or any other keyless one", () => {
    for (const layer of [
      DEFAULT_LAYER,
      "airQuality",
      "wildfire",
      "modelWind",
    ]) {
      const { state, check } = firstRender(layer);
      expect(state).toMatchObject({ layer, held: false, busy: false });
      expect(check).not.toHaveBeenCalled();
    }
  });
});
