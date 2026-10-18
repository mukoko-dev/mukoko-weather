/**
 * Structural tests for the map timeline scrubber (node env, no DOM).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "MapTimeline.tsx"), "utf-8");
const css = readFileSync(
  resolve(__dirname, "../../../app/globals.css"),
  "utf-8",
);

describe("MapTimeline — controls", () => {
  it("has play/pause, earlier and later controls with accessible names", () => {
    expect(source).toContain("Play forecast timeline");
    expect(source).toContain("Pause forecast timeline");
    expect(source).toContain('aria-label="Earlier time"');
    expect(source).toContain('aria-label="Later time"');
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
    expect(source).toContain("aria-label={inputLabel}");
    expect(source).toContain("aria-valuetext={valueText}");
    expect(source).toContain('className="springhare"');
    expect(css).toContain(".springhare::-webkit-slider-thumb");
    expect(css).toContain(".springhare::-moz-range-thumb");
    expect(css).toContain(".springhare:focus-visible::-webkit-slider-thumb");
  });

  it("keeps the 48px hit area on the input", () => {
    expect(css).toMatch(/\.springhare \{[^}]*h-\[var\(--touch-target-min\)\]/);
  });

  it("works for any frame count: one equal flex column per gap, no fixed grid", () => {
    expect(source).toContain("Array.from({ length: last }");
    expect(source).toContain('className="relative flex-1"');
    expect(source).not.toContain("grid-cols-");
  });

  it("marks the first stop and, on a forward timeline, each new local day", () => {
    expect(source).toContain('{ label: "Now", primary: true }');
    expect(source).toContain("stops[i]?.dayStart");
  });

  it("ticks the final frame too, at the right edge", () => {
    expect(source).toContain('edge="right"');
    expect(source).toContain("i === last - 1 && endTick");
  });

  it("drops weekday labels that would collide with the first", () => {
    expect(source).toContain("export const MIN_LABEL_GAP_STEPS = 4;");
    expect(source).toContain("index >= MIN_LABEL_GAP_STEPS");
  });

  it("observed loops keep the frames' own labels at the ends, with no zone line", () => {
    expect(source).toContain("frames[0]?.label");
    expect(source).toContain("frames[last].label");
    expect(source).toContain(": null;");
  });

  it("reads every forward label from frameStops (place time), never the viewer's clock", () => {
    expect(source).toContain("frameStops(");
    expect(source).not.toMatch(/getHours\(|toLocaleTimeString\(/);
  });

  it("flags an estimated offset in the readout", () => {
    expect(source).toContain("`≈ ${zone.zoneName} time`");
  });

  it("does not spam the live region while playing", () => {
    expect(source).toContain('aria-live={playing ? "off" : "polite"}');
    expect(source).toContain('useMziziHarness("map-timeline")');
  });
});
