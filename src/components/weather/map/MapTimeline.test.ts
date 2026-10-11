/**
 * Structural tests for the map timeline scrubber (node env, no DOM).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { TIMELINE_STEPS } from "@/lib/map-layers";

const source = readFileSync(resolve(__dirname, "MapTimeline.tsx"), "utf-8");
const css = readFileSync(
  resolve(__dirname, "../../../app/globals.css"),
  "utf-8",
);

describe("MapTimeline — controls", () => {
  it("has play/pause, earlier and later controls with accessible names", () => {
    expect(source).toContain("Play forecast timeline");
    expect(source).toContain("Pause forecast timeline");
    expect(source).toContain('aria-label="Earlier forecast time"');
    expect(source).toContain('aria-label="Later forecast time"');
  });

  it("disables stepping past either end", () => {
    expect(source).toContain("disabled={step <= 0}");
    expect(source).toContain("disabled={step >= last}");
  });

  it("uses Mzizi round controls (fauna classes), not hand-rolled buttons", () => {
    expect(source).toContain('className="duiker-solid"');
    expect(source.match(/className="duiker"/g)).toHaveLength(2);
  });

  it("stops playback when the user scrubs or steps", () => {
    expect(source).toMatch(/const go = [\s\S]*?onPlayingChange\(false\)/);
  });
});

describe("MapTimeline — scrubber", () => {
  it("is a native range input: keyboard operable with aria-valuetext", () => {
    expect(source).toContain('type="range"');
    expect(source).toContain('aria-label="Forecast time"');
    expect(source).toContain('aria-valuetext={current?.valueText ?? "Now"}');
    expect(source).toContain('className="springhare"');
    expect(css).toContain(".springhare::-webkit-slider-thumb");
    expect(css).toContain(".springhare::-moz-range-thumb");
    expect(css).toContain(".springhare:focus-visible::-webkit-slider-thumb");
  });

  it("keeps the 48px hit area on the input", () => {
    expect(css).toMatch(/\.springhare \{[^}]*h-\[var\(--touch-target-min\)\]/);
  });

  it("tick grid has one column per gap between stops", () => {
    // grid-cols must be a literal for Tailwind; pin it to TIMELINE_STEPS.
    expect(source).toContain(
      `grid-cols-[repeat(${TIMELINE_STEPS - 1},minmax(0,1fr))]`,
    );
  });

  it("marks the current time and labels new local days", () => {
    expect(source).toContain('{isNow ? "Now" : stop?.day}');
    expect(source).toContain("stop?.dayStart");
  });

  it("ticks the final stop too, at the right edge", () => {
    expect(source).toContain(
      '<Tick stop={stops?.[last]} index={last} edge="right" />',
    );
  });

  it("drops weekday labels that would collide with Now", () => {
    expect(source).toContain("export const MIN_LABEL_GAP_STEPS = 4;");
    expect(source).toContain("index >= MIN_LABEL_GAP_STEPS");
  });

  it("flags an estimated offset in the readout", () => {
    expect(source).toContain("`≈ ${zoneName} time`");
    expect(source).toContain(
      "timelineStops(now, offsetSeconds, zoneName, approximate)",
    );
  });

  it("reads every label from timelineStops (place time), never the viewer's clock", () => {
    expect(source).not.toMatch(/getHours\(|toLocaleTimeString\(/);
  });

  it("does not spam the live region while playing", () => {
    expect(source).toContain('aria-live={playing ? "off" : "polite"}');
    expect(source).toContain('useMziziHarness("map-timeline")');
  });
});
