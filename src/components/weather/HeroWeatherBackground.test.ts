/**
 * Tests for HeroWeatherBackground — validates the condition-based animated
 * background layer behind the CurrentConditions hero card. Source-based
 * structural testing (Vitest runs in Node without a DOM/WebGL context).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "HeroWeatherBackground.tsx"),
  "utf-8",
);

describe("HeroWeatherBackground — component contract", () => {
  it("is a client component", () => {
    expect(source).toContain('"use client"');
  });

  it("exports HeroWeatherBackground as a named function", () => {
    expect(source).toContain("export function HeroWeatherBackground");
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

describe("HeroWeatherBackground — performance discipline", () => {
  it("caps the renderer pixel ratio at 1", () => {
    expect(source).toContain("maxPixelRatio: 1");
  });

  it("pauses/resumes on tab visibility changes", () => {
    expect(source).toContain('addEventListener("visibilitychange"');
    expect(source).toContain("visibilityState");
    expect(source).toContain("handle.pause()");
    expect(source).toContain("handle.resume()");
  });

  it("pauses/resumes based on viewport intersection", () => {
    expect(source).toContain("IntersectionObserver");
    expect(source).toContain("isIntersecting");
    expect(source).toContain("observer?.disconnect()");
  });

  it("disposes the scene on unmount", () => {
    expect(source).toContain("handle?.dispose()");
  });
});

describe("HeroWeatherBackground — reduced motion + resilience", () => {
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

describe("HeroWeatherBackground — accessibility + layout", () => {
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

describe("HeroWeatherBackground — scene mapping", () => {
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
