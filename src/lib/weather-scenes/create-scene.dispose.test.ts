/**
 * Behavioural test: disposing a weather scene releases its WebGL context
 * (renderer.forceContextLoss), so a page never holds two contexts — the
 * loading scene's and the backdrop's — at once. Three.js and the scene
 * builder are mocked; Vitest runs in Node without WebGL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls: string[] = [];

vi.mock("three", () => {
  class WebGLRenderer {
    domElement = { tag: "canvas" };
    constructor(public opts: Record<string, unknown>) {
      calls.push(`renderer:${String(opts.powerPreference)}`);
    }
    setSize() {}
    setPixelRatio() {}
    render() {}
    dispose() {
      calls.push("dispose");
    }
    forceContextLoss() {
      calls.push("forceContextLoss");
    }
  }
  class Scene {}
  class PerspectiveCamera {
    position = { set() {}, x: 0, y: 0 };
    lookAt() {}
    updateProjectionMatrix() {}
  }
  class Clock {
    getElapsedTime() {
      return 0;
    }
    getDelta() {
      return 0;
    }
  }
  return { WebGLRenderer, Scene, PerspectiveCamera, Clock };
});

vi.mock("./scenes/clear", () => ({
  buildClearScene: () => ({
    update() {},
    dispose() {
      calls.push("elements.dispose");
    },
  }),
}));

describe("createWeatherScene dispose", () => {
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal("window", {
      devicePixelRatio: 3,
      addEventListener() {},
      removeEventListener() {},
    });
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  function container() {
    const children = new Set<unknown>();
    return {
      clientWidth: 400,
      clientHeight: 800,
      appendChild: (c: unknown) => children.add(c),
      removeChild: (c: unknown) => children.delete(c),
      contains: (c: unknown) => children.has(c),
      children,
    };
  }

  it("asks for a low-power context and releases it on dispose", async () => {
    const { createWeatherScene } = await import("./create-scene");
    const el = container();
    const handle = await createWeatherScene(el as unknown as HTMLElement, {
      type: "clear",
      isDay: true,
      isMobile: true,
      maxPixelRatio: 1,
    });
    expect(calls).toContain("renderer:low-power");
    expect(el.children.size).toBe(1);
    handle.dispose();
    expect(calls).toEqual(
      expect.arrayContaining([
        "elements.dispose",
        "dispose",
        "forceContextLoss",
      ]),
    );
    expect(calls.indexOf("forceContextLoss")).toBeGreaterThan(
      calls.indexOf("dispose"),
    );
    expect(el.children.size).toBe(0);
  });
});
