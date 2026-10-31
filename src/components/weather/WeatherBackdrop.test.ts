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

  it("is the sky box at the top of the page, behind all content (no IntersectionObserver needed)", () => {
    // POSITIVE z-0, never negative: iOS Safari paints negative-z elements
    // behind the body background (overflow-x:hidden body), making the
    // backdrop invisible on iPhone. Content stacks above via z-10. The box
    // (.kestrel-reach) is absolute at the top of the page, not fixed: it
    // scrolls away so lower sections sit on the ordinary surface.
    expect(source).toContain(
      '"kestrel-reach pointer-events-none z-0 overflow-hidden"',
    );
    expect(source).not.toMatch(/\bfixed\b[^"]*inset-0/);
    expect(source).not.toContain("-z-10");
    // Always on-screen while the page is visible — tab visibility is the
    // only pause signal, so no observer is constructed (the docstring may
    // still mention the API by name when explaining why it's absent).
    expect(source).not.toContain("new IntersectionObserver");
  });

  it("fades the sky out at its foot through the .kestrel-reach mask, not an overlay", () => {
    expect(source).toContain("kestrel-reach");
    expect(source).not.toContain("transparent_var(--sky-fade-from)");
    expect(source).not.toContain("to-surface-base");
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
    expect(source).toContain("kestrel ${SKY_CLASS[family]}");
    expect(source).toContain("skyFamily(weatherCode, isDay)");
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

  it("has no readability veil: the header and breadcrumb text take the sky foreground", () => {
    expect(source).not.toContain("hornbill-veil");
  });

  it("carries the static night stars and rain streaks, never animated", () => {
    expect(source).toContain("skyTexture(family)");
    expect(source).toContain('"kestrel-stars"');
    expect(source).toContain('"kestrel-streaks"');
  });

  it("uses only token-backed gradient classes (no hardcoded hex)", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    expect(source).not.toContain("rgba(");
  });
});

describe("WeatherBackdrop — scene mapping + twilight", () => {
  it("resolves the sky class from the hero's one family mapping, not a local switch", () => {
    expect(source).toContain("SKY_CLASS");
    expect(source).not.toContain("skyClassName");
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

describe("WeatherBackdrop — subdued particle layer", () => {
  it("keeps the particle layer subdued so it never fights the hero text", () => {
    // The sky itself is solid (it is the page); only the particles are dimmed,
    // and further in dark theme.
    expect(source).toContain(
      'className="absolute inset-0 opacity-30 dark:opacity-20"',
    );
    expect(source).not.toContain("opacity-80");
  });

  it("does not use the retired solid plate", () => {
    expect(source).not.toMatch(/\bkori\b/);
  });
});

describe("WeatherBackdrop — device and scroll policy (v0.10.0 perf)", () => {
  it("decides whether to animate via shouldAnimateBackdrop (reduced motion, Save-Data, low-end)", () => {
    expect(source).toContain("shouldAnimateBackdrop(readBackdropHints())");
  });

  it("idles the loop while scrolling and when the sky has scrolled away", () => {
    expect(source).toContain('addEventListener("scroll", handleScroll');
    expect(source).toContain("passive: true");
    expect(source).toContain("shouldRunBackdrop({");
    expect(source).toContain('removeEventListener("scroll", handleScroll)');
  });

  it("releases the WebGL context on dispose (one context per page)", () => {
    const scene = readFileSync(
      resolve(__dirname, "../../lib/weather-scenes/create-scene.ts"),
      "utf-8",
    );
    expect(scene).toContain("renderer.forceContextLoss()");
    expect(scene).toContain('powerPreference: "low-power"');
  });

  it("the loading scene delays Three.js so quick loads never open a second context", () => {
    const loading = readFileSync(
      resolve(__dirname, "WeatherLoadingScene.tsx"),
      "utf-8",
    );
    expect(loading).toContain("LOADING_SCENE_3D_DELAY_MS");
    expect(loading).toContain("window.clearTimeout(startTimer)");
  });
});
