/**
 * Tests for WeatherBackdrop — validates the fixed, full-viewport
 * condition-based animated sky behind the whole location page (Apple
 * Weather style). Source-based structural testing (Vitest runs in Node
 * without a DOM/WebGL context).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "WeatherBackdrop.tsx"),
  "utf-8",
);

describe("WeatherBackdrop — component contract", () => {
  it("is a client component", () => {
    expect(source).toContain('"use client"');
  });

  it("exports WeatherBackdrop as a named function", () => {
    expect(source).toContain("export function WeatherBackdrop");
  });

  it("accepts weatherCode, windSpeed and isDay props", () => {
    expect(source).toContain("weatherCode");
    expect(source).toContain("windSpeed");
    expect(source).toContain("isDay");
  });

  it("derives the scene from the current WMO code via resolveScene", () => {
    expect(source).toContain("resolveScene(weatherCode, windSpeed)");
  });
});

describe("WeatherBackdrop — performance discipline", () => {
  it("caps the renderer pixel ratio at 1", () => {
    expect(source).toContain("maxPixelRatio: 1");
  });

  it("pauses/resumes on tab visibility changes", () => {
    expect(source).toContain('addEventListener("visibilitychange"');
    expect(source).toContain("visibilityState");
    expect(source).toContain("handle.pause()");
    expect(source).toContain("handle.resume()");
  });

  it("is a fixed full-viewport backdrop behind all content (no IntersectionObserver needed)", () => {
    expect(source).toContain('"pointer-events-none fixed inset-0 -z-10 overflow-hidden"');
    // Always on-screen while the page is visible — tab visibility is the
    // only pause signal, so no observer is constructed (the docstring may
    // still mention the API by name when explaining why it's absent).
    expect(source).not.toContain("new IntersectionObserver");
  });

  it("fades the sky into the surface background lower down the page", () => {
    expect(source).toContain("from-transparent");
    expect(source).toContain("to-surface-base");
  });

  it("disposes the scene on unmount", () => {
    expect(source).toContain("handle?.dispose()");
  });
});

describe("WeatherBackdrop — reduced motion + resilience", () => {
  it("respects prefers-reduced-motion", () => {
    expect(source).toContain("prefers-reduced-motion: reduce");
  });

  it("only mounts the Three.js container when motion is allowed", () => {
    expect(source).toContain("{animate && <div ref={containerRef}");
  });

  it("always paints a static mineral gradient as the fallback", () => {
    expect(source).toContain("weaver-sky");
  });

  it("catches scene creation failures so the card never breaks", () => {
    expect(source).toContain(".catch(()");
  });
});

describe("WeatherBackdrop — accessibility + layout", () => {
  it("is decorative and hidden from assistive tech", () => {
    expect(source).toContain('aria-hidden="true"');
  });

  it("is non-interactive and absolutely positioned within the card", () => {
    expect(source).toContain("pointer-events-none");
    expect(source).toContain("absolute inset-0");
  });

  it("applies a readability scrim over the animation", () => {
    expect(source).toContain("weaver-scrim");
  });

  it("uses only token-backed gradient classes (no hardcoded hex)", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    expect(source).not.toContain("rgba(");
  });
});

describe("WeatherBackdrop — scene mapping", () => {
  const sceneClasses = [
    "weaver-sky-clear-day",
    "weaver-sky-clear-night",
    "weaver-sky-cloudy",
    "weaver-sky-rain",
    "weaver-sky-thunderstorm",
    "weaver-sky-snow",
    "weaver-sky-fog",
    "weaver-sky-windy",
  ];

  it("maps every scene type to a literal gradient class", () => {
    for (const cls of sceneClasses) {
      expect(source).toContain(cls);
    }
  });
});
