/**
 * Tests for the bottom-sheet layer chips (WeatherLayerPanel).
 * Node-env structural checks (no DOM renderer): the chips must be labelled,
 * drawn from MAP_CHIPS, and sized from the touch-target token.
 */
import { createElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Flame, Layers } from "lucide-react";
import {
  MAP_CHIPS,
  AIR_QUALITY_LAYER_ID,
  WILDFIRE_LAYER_ID,
} from "@/lib/map-layers";
import { mount } from "@/lib/test-render";
import { trackEvent } from "@/lib/analytics";
import {
  CHIP_ICONS,
  WeatherLayerPanel,
  chipIcon,
  chipScrollDelta,
  scrollChipIntoView,
} from "./WeatherLayerPanel";

vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));

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

  it("brings the active chip into view, so the layer the map opens on (the sixth chip) is seen selected", () => {
    // The row (padding 16 start, 24 end) shows x 16..369 of a 393 px phone.
    const row = { left: 0, right: 393 };
    const inset = { start: 16, end: 24 };
    // Already inside: nothing to do.
    expect(chipScrollDelta(row, { left: 100, right: 240 }, inset)).toBe(0);
    // Past the end, or half under the fade: scroll forward just enough.
    expect(chipScrollDelta(row, { left: 420, right: 530 }, inset)).toBe(161);
    expect(chipScrollDelta(row, { left: 300, right: 380 }, inset)).toBe(11);
    // Before the start: scroll back just enough.
    expect(chipScrollDelta(row, { left: -50, right: 60 }, inset)).toBe(-66);
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

describe("WeatherLayerPanel: choosing while a layer is busy (#542)", () => {
  beforeEach(() => {
    vi.mocked(trackEvent).mockClear();
  });

  /** The person chose Rain; Rain is busy, so Satellite is on screen. */
  async function busyPanel() {
    const onLayerChange = vi.fn();
    const onRecheck = vi.fn();
    const panel = (extra: Record<string, unknown> = {}) =>
      createElement(WeatherLayerPanel, {
        activeLayer: "satellite",
        chosenLayer: "precipitationIntensity",
        onLayerChange,
        onRecheck,
        locationSlug: "harare",
        ...extra,
      });
    const m = await mount(panel());
    return { m, onLayerChange, onRecheck, panel };
  }

  it("shows the layer on screen as pressed, and only that one", async () => {
    const { m } = await busyPanel();
    const pressed = m.find({ "aria-pressed": "true" });
    expect(pressed.map((n) => n.textContent.trim())).toEqual(["Satellite"]);
    await m.unmount();
  });

  it("tapping the pressed fallback chip CHOOSES it (the stored choice moves off the busy layer)", async () => {
    const { m, onLayerChange, onRecheck } = await busyPanel();
    await m.click(m.button("Satellite")!);
    expect(onLayerChange).toHaveBeenCalledExactlyOnceWith("satellite");
    expect(onRecheck).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledExactlyOnceWith("map_layer_changed", {
      layer: "satellite",
      location: "harare",
    });
    await m.unmount();
  });

  it("tapping the busy layer's own chip looks again, and is not a change of layer", async () => {
    const { m, onLayerChange, onRecheck } = await busyPanel();
    await m.click(m.button("Rain")!);
    expect(onRecheck).toHaveBeenCalledTimes(1);
    expect(onLayerChange).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
    await m.unmount();
  });

  it("tapping any other chip changes the layer as before", async () => {
    const { m, onLayerChange, onRecheck } = await busyPanel();
    await m.click(m.button("Wind")!);
    expect(onLayerChange).toHaveBeenCalledExactlyOnceWith("windSpeed");
    expect(onRecheck).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledTimes(1);
    await m.unmount();
  });

  it("with nothing busy, tapping the chip already on screen does nothing, as before", async () => {
    const onLayerChange = vi.fn();
    const onRecheck = vi.fn();
    const m = await mount(
      createElement(WeatherLayerPanel, {
        activeLayer: "satellite",
        onLayerChange,
        onRecheck,
        locationSlug: "harare",
      }),
    );
    await m.click(m.button("Satellite")!);
    expect(onLayerChange).not.toHaveBeenCalled();
    expect(onRecheck).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
    await m.unmount();
  });
});

describe("WeatherLayerPanel: the active chip is brought into view (#542)", () => {
  /** A panel with a measurable row: 393 wide, the pressed chip off its right edge. */
  async function panelWith(visible: boolean) {
    const props = (v: boolean) =>
      createElement(WeatherLayerPanel, {
        activeLayer: "satellite",
        onLayerChange: () => {},
        locationSlug: "harare",
        visible: v,
      });
    const m = await mount(props(visible));
    const [row] = m.find({ "aria-label": "Map layers" });
    const [chip] = m.find({ "aria-pressed": "true" });
    return { m, row, chip, props };
  }
  const box = (left: number, right: number) => ({
    left,
    right,
    top: 0,
    bottom: 49,
    width: right - left,
    height: 49,
  });

  it("scrolls the row, not the sheet, to a position worked out from where the row is now, with no animation", async () => {
    const { m, row, chip, props } = await panelWith(false);
    row.box = box(0, 393);
    chip.box = box(450, 560);
    row.scrollLeft = 100;
    await m.rerender(props(true));
    // Instant and absolute: a smooth or relative scroll breaks when the layer
    // changes twice in a moment (see the comment in WeatherLayerPanel).
    expect(row.scrollCalls).toEqual([{ left: 267, behavior: "instant" }]);
    await m.unmount();
  });

  it("does not measure a folded sheet (its row has no size), and does when the sheet opens again", async () => {
    const { m, row, chip, props } = await panelWith(false);
    // Folded: nothing happened on mount.
    expect(row.scrollCalls).toEqual([]);
    // A row with no size cannot be measured even if it is told it is visible.
    await m.rerender(props(true));
    expect(row.scrollCalls).toEqual([]);
    // Fold, and unfold once it can be measured: the chip is brought in.
    await m.rerender(props(false));
    row.box = box(0, 393);
    chip.box = box(450, 560);
    await m.rerender(props(true));
    expect(row.scrollCalls).toEqual([{ left: 167, behavior: "instant" }]);
    await m.unmount();
  });

  it("brings it in again each time the sheet is unfolded and the chip is out of view", async () => {
    const { m, row, chip, props } = await panelWith(true);
    row.box = box(0, 393);
    chip.box = box(450, 560);
    await m.rerender(props(false));
    await m.rerender(props(true));
    expect(row.scrollCalls).toEqual([{ left: 167, behavior: "instant" }]);
    // The row is scrolled away again meanwhile (the stand-in has no layout, so
    // the chip's box does not follow the scroll).
    row.scrollLeft = 0;
    await m.rerender(props(false));
    await m.rerender(props(true));
    expect(row.scrollCalls).toEqual([
      { left: 167, behavior: "instant" },
      { left: 167, behavior: "instant" },
    ]);
    await m.unmount();
  });

  it("follows the layer when it changes while the sheet is open (the fallback after a busy verdict)", async () => {
    const { m, row, chip } = await panelWith(true);
    row.box = box(0, 393);
    chip.box = box(450, 560);
    await m.rerender(
      createElement(WeatherLayerPanel, {
        activeLayer: "satellite",
        chosenLayer: "precipitationIntensity",
        onLayerChange: () => {},
        locationSlug: "harare",
      }),
    );
    // Same pressed chip, same sheet: nothing new to place.
    expect(row.scrollCalls).toEqual([]);
    m.button("Wind")!.box = box(450, 560);
    await m.rerender(
      createElement(WeatherLayerPanel, {
        activeLayer: "windSpeed",
        onLayerChange: () => {},
        locationSlug: "harare",
      }),
    );
    // A different chip is pressed now, and it is the one that gets measured.
    expect(row.scrollCalls).toEqual([{ left: 167, behavior: "instant" }]);
    await m.unmount();
  });

  it("does nothing when the chip is already inside the row", async () => {
    const { m, row, chip, props } = await panelWith(false);
    row.box = box(0, 393);
    chip.box = box(100, 210);
    await m.rerender(props(true));
    expect(row.scrollCalls).toEqual([]);
    await m.unmount();
  });
});
