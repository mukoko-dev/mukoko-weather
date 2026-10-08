/**
 * Tests for WeatherBackdrop — validates the fixed, full-viewport
 * condition-based animated sky behind the whole location page (Apple
 * Weather style). Source-based structural testing (Vitest runs in Node
 * without a DOM/WebGL context).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "WeatherBackdrop.tsx"), "utf-8");

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
    // POSITIVE z-0, never negative: iOS Safari paints fixed negative-z
    // elements behind the body background (overflow-x:hidden body), making
    // the backdrop invisible on iPhone. Content stacks above via z-10.
    expect(source).toContain(
      '"pointer-events-none fixed inset-0 z-0 overflow-hidden"',
    );
    expect(source).not.toContain("-z-10");
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
    expect(source).toContain("{animate && (");
    expect(source).toContain("ref={containerRef}");
  });

  it("always paints the static real-weather sky gradient as the fallback", () => {
    // Same palette as the Three.js layer (palette.ts ↔ --weather-sky-*).
    expect(source).toContain("skyClassName(sceneType, isDay, phase)");
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

  it("applies a readability veil over the sky behind header/breadcrumb text", () => {
    expect(source).toContain("hornbill-veil");
  });

  it("uses only token-backed gradient classes (no hardcoded hex)", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    expect(source).not.toContain("rgba(");
  });
});

describe("WeatherBackdrop — scene mapping + twilight", () => {
  it("resolves sky classes from the shared palette, not a local switch", () => {
    expect(source).toContain("skyClassName");
    expect(source).not.toContain("weaver-sky");
  });

  it("derives a dawn/dusk phase from the location clock and passes it on", () => {
    expect(source).toContain("skyPhase(isDay, currentTime, sunrise, sunset)");
    expect(source).toContain("phase,");
  });

  it("restarts the scene when the phase changes", () => {
    expect(source).toContain(
      "[animate, isMobile, isDay, phase, sceneType, windSpeed]",
    );
  });
});

describe("WeatherBackdrop — subdued behind the sky plate", () => {
  it("lowers the sky and particle layers so the hero plate reads as the hero", () => {
    expect(source).toContain("absolute inset-0 opacity-80 ${skyClassName(");
    // Particles dim further in dark theme, like the dark-theme sky tokens.
    expect(source).toContain(
      'className="absolute inset-0 opacity-75 dark:opacity-40"',
    );
  });

  it("does not paint the hero plate itself", () => {
    expect(source).not.toMatch(/className=\{?[`"][^`"]*\bkori\b/);
  });
});
