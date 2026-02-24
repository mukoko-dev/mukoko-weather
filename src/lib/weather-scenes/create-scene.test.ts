/**
 * Tests for create-scene.ts — validates the Three.js scene factory structure,
 * lifecycle management, and error handling patterns.
 *
 * Uses source-based structural testing since Three.js WebGL requires a real
 * GPU context that is unavailable in Node test environments.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "create-scene.ts"),
  "utf-8",
);

describe("createWeatherScene — exports and signature", () => {
  it("exports createWeatherScene as an async function", () => {
    expect(source).toContain("export async function createWeatherScene");
  });

  it("accepts container and config parameters", () => {
    expect(source).toContain("container: HTMLElement");
    expect(source).toContain("config: WeatherSceneConfig");
  });

  it("returns a dispose function", () => {
    expect(source).toContain("Promise<{ dispose: () => void }>");
  });
});

describe("createWeatherScene — error handling", () => {
  it("returns noop for zero-size containers", () => {
    // Guard against rendering into invisible/unmounted elements
    expect(source).toContain("width === 0 || height === 0");
    expect(source).toContain("return noop");
  });

  it("returns noop when Three.js fails to load", () => {
    expect(source).toMatch(/catch\s*\{[\s\S]*?return noop.*Three\.js failed/);
  });

  it("returns noop when WebGL is unavailable", () => {
    expect(source).toMatch(/catch\s*\{[\s\S]*?return noop.*WebGL unavailable/);
  });

  it("cleans up renderer when scene module fails to load", () => {
    expect(source).toContain("renderer.dispose()");
    expect(source).toContain("container.removeChild(renderer.domElement)");
  });
});

describe("createWeatherScene — scene lifecycle", () => {
  it("creates a Three.js renderer with alpha", () => {
    expect(source).toContain("WebGLRenderer");
    expect(source).toContain("alpha: true");
  });

  it("sets lower pixel ratio for mobile devices", () => {
    expect(source).toContain("config.isMobile ? 1");
  });

  it("creates a PerspectiveCamera", () => {
    expect(source).toContain("PerspectiveCamera");
  });

  it("runs an animation loop with disposed check", () => {
    expect(source).toContain("function animate()");
    expect(source).toContain("if (disposed) return");
    expect(source).toContain("requestAnimationFrame(animate)");
  });

  it("applies subtle camera drift across all scenes", () => {
    expect(source).toContain("Math.sin(elapsed");
    expect(source).toContain("camera.lookAt");
  });

  it("adds a resize handler", () => {
    expect(source).toContain('addEventListener("resize"');
    expect(source).toContain("{ passive: true }");
    expect(source).toContain("camera.updateProjectionMatrix");
  });
});

describe("createWeatherScene — dispose cleanup", () => {
  it("sets disposed flag to stop animation loop", () => {
    expect(source).toContain("disposed = true");
  });

  it("cancels the animation frame", () => {
    expect(source).toContain("cancelAnimationFrame(frameId)");
  });

  it("removes the resize event listener", () => {
    expect(source).toContain('removeEventListener("resize", handleResize)');
  });

  it("disposes scene elements", () => {
    expect(source).toContain("elements.dispose()");
  });

  it("disposes the renderer", () => {
    // dispose() should call renderer.dispose()
    expect(source).toMatch(/dispose\(\)\s*\{[\s\S]*?renderer\.dispose\(\)/);
  });

  it("removes the canvas from the DOM", () => {
    expect(source).toContain("container.contains(renderer.domElement)");
    expect(source).toContain("container.removeChild(renderer.domElement)");
  });

  it("guards resize handler against disposed state", () => {
    // handleResize should check disposed before resizing
    expect(source).toMatch(/function handleResize[\s\S]*?if \(disposed\) return/);
  });
});

describe("loadSceneBuilder — scene type coverage", () => {
  it("handles all 8 weather scene types", () => {
    const sceneTypes = [
      "clear",
      "partly-cloudy",
      "cloudy",
      "rain",
      "thunderstorm",
      "fog",
      "snow",
      "windy",
    ];
    for (const type of sceneTypes) {
      expect(source).toContain(`case "${type}"`);
    }
  });

  it("uses dynamic imports for code splitting", () => {
    expect(source).toContain('import("./scenes/clear")');
    expect(source).toContain('import("./scenes/rain")');
    expect(source).toContain('import("./scenes/thunderstorm")');
  });

  it("falls back to partly-cloudy for unknown types", () => {
    // default case should load partly-cloudy
    expect(source).toMatch(/default:\s*\{[\s\S]*?partly-cloudy/);
  });
});
