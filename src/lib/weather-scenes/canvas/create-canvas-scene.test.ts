import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WeatherSceneConfig } from "../types";
import {
  createCanvasScene,
  MAX_FPS,
  MAX_PIXEL_RATIO,
  MAX_STEP,
  type CanvasSceneDeps,
} from "./create-canvas-scene";
import { seeded } from "./random";

/** A canvas and 2D context that only record what the factory does to them. */
function fakeCanvas(hasContext = true) {
  const log: string[] = [];
  const ctx = new Proxy(
    {
      globalAlpha: 1,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      createRadialGradient: () => ({ addColorStop: () => undefined }),
    } as Record<string, unknown>,
    {
      get(target, key: string) {
        if (key in target) return target[key];
        return (...args: unknown[]) => {
          log.push(
            `${key}(${args.map((a) => (typeof a === "number" ? Math.round(a * 100) / 100 : "·")).join(",")})`,
          );
        };
      },
      set(target, key: string, value) {
        target[key] = value;
        return true;
      },
    },
  );
  const attrs: Record<string, string> = {};
  const canvas = {
    width: 0,
    height: 0,
    className: "",
    getContext: () => (hasContext ? ctx : null),
    setAttribute: (k: string, v: string) => {
      attrs[k] = v;
    },
    attrs,
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, raw: canvas, log };
}

function fakeContainer(w = 393, h = 640) {
  const children: unknown[] = [];
  return {
    clientWidth: w,
    clientHeight: h,
    children,
    appendChild: (c: unknown) => {
      children.push(c);
      return c;
    },
    removeChild: (c: unknown) => {
      children.splice(children.indexOf(c), 1);
      return c;
    },
    contains: (c: unknown) => children.includes(c),
  };
}

const config: WeatherSceneConfig = {
  type: "rain",
  isDay: true,
  isMobile: true,
  windSpeed: 10,
};

describe("createCanvasScene", () => {
  let frames: ((now: number) => void)[] = [];
  let cancelled: number[] = [];
  let canvases: ReturnType<typeof fakeCanvas>[] = [];
  let pixelRatio = 3;
  // The size observers a scene registered, by the order it registered them.
  let observers: (() => void)[] = [];
  let stopped = 0;

  const deps = (): CanvasSceneDeps => ({
    createCanvas: () => {
      const c = fakeCanvas();
      canvases.push(c);
      return c.canvas;
    },
    raf: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    caf: (id) => {
      cancelled.push(id);
    },
    pixelRatio: () => pixelRatio,
    observe: (_el, cb) => {
      observers.push(cb);
      return () => {
        stopped++;
      };
    },
    rng: seeded(1),
  });

  beforeEach(() => {
    frames = [];
    cancelled = [];
    canvases = [];
    pixelRatio = 3;
    observers = [];
    stopped = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Run the scheduled frame at `now` (the latest one registered). */
  const tick = (now: number) => {
    const f = frames.pop();
    expect(f, "a frame was scheduled").toBeDefined();
    f?.(now);
  };
  it("returns a no-op handle when there is no 2D context", async () => {
    const noCtx = fakeCanvas(false);
    const handle = await createCanvasScene(
      fakeContainer() as unknown as HTMLElement,
      config,
      {
        ...deps(),
        createCanvas: () => noCtx.canvas,
      },
    );
    handle.pause();
    handle.resume();
    handle.dispose();
    expect(frames).toHaveLength(0);
    expect(observers).toHaveLength(0);
  });

  it("waits for a box that has no size yet, and starts when it gets one", async () => {
    for (const [w, h] of [
      [0, 640],
      [393, 0],
    ]) {
      frames = [];
      observers = [];
      canvases = [];
      const container = fakeContainer(w, h);
      const handle = await createCanvasScene(
        container as unknown as HTMLElement,
        config,
        deps(),
      );
      // Nothing is on the page, and nothing is scheduled, while the box is empty.
      expect(container.children).toHaveLength(0);
      expect(frames).toHaveLength(0);
      expect(observers).toHaveLength(1);
      container.clientWidth = 393;
      container.clientHeight = 640;
      observers[0]();
      expect(container.children).toHaveLength(1);
      expect(canvases[0].raw.width).toBe(786);
      expect(frames).toHaveLength(1);
      handle.dispose();
    }
  });

  it("does not run a frame while paused before the box has a size", async () => {
    const container = fakeContainer(0, 0);
    const handle = await createCanvasScene(
      container as unknown as HTMLElement,
      config,
      deps(),
    );
    handle.pause();
    container.clientWidth = 393;
    container.clientHeight = 640;
    observers[0]();
    expect(container.children).toHaveLength(1);
    expect(frames).toHaveLength(0); // painted once, but the loop is paused
    handle.resume();
    expect(frames).toHaveLength(1);
  });

  it("puts one aria-hidden canvas in the container, capped at a pixel ratio of 2", async () => {
    const container = fakeContainer(393, 640);
    await createCanvasScene(
      container as unknown as HTMLElement,
      config,
      deps(),
    );
    expect(container.children).toHaveLength(1);
    const main = canvases[0].raw;
    expect(main.attrs["aria-hidden"]).toBe("true");
    expect(main.className).toContain("absolute inset-0");
    expect(MAX_PIXEL_RATIO).toBe(2);
    expect(main.width).toBe(393 * 2);
    expect(main.height).toBe(640 * 2);
    pixelRatio = 1;
    // The main canvas is the first one a call creates (sprites come later).
    const index = canvases.length;
    const small = fakeContainer(100, 50);
    await createCanvasScene(small as unknown as HTMLElement, config, deps());
    expect(canvases[index].raw.width).toBe(100);
  });

  it("honours the caller's pixel-ratio cap, and never goes above 2 whatever it asks for", async () => {
    pixelRatio = 3;
    for (const [asked, expected] of [
      [1, 1],
      [1.5, 1.5],
      [2, 2],
      [4, 2],
      [undefined, 2],
    ] as const) {
      const index = canvases.length;
      await createCanvasScene(
        fakeContainer(100, 50) as unknown as HTMLElement,
        { ...config, maxPixelRatio: asked },
        deps(),
      );
      expect(canvases[index].raw.width, `asked ${asked}`).toBe(
        Math.round(100 * expected),
      );
      expect(canvases[index].raw.height, `asked ${asked}`).toBe(
        Math.round(50 * expected),
      );
    }
  });

  it("clips every frame to the canvas, so nothing is drawn outside the boundary", async () => {
    await createCanvasScene(
      fakeContainer() as unknown as HTMLElement,
      config,
      deps(),
    );
    const log = canvases[0].log;
    expect(log.filter((l) => l.startsWith("clip"))).toHaveLength(1);
    expect(log.indexOf("rect(0,0,393,640)")).toBeGreaterThan(-1);
    expect(log.indexOf("rect(0,0,393,640)")).toBeLessThan(
      log.indexOf("clip()"),
    );
    expect(log.indexOf("clip()")).toBeLessThan(log.indexOf("restore()"));
    // The transform is set to the pixel ratio before anything is drawn.
    expect(log[0]).toMatch(/^setTransform\(2,0,0,2,0,0\)/);
  });

  it("is capped at 30 frames a second, however often the browser asks", async () => {
    await createCanvasScene(
      fakeContainer() as unknown as HTMLElement,
      config,
      deps(),
    );
    const painted = () =>
      canvases[0].log.filter((l) => l.startsWith("clearRect")).length;
    const first = painted(); // the first paint, before any frame
    // A 120 Hz display asks every 8.3 ms for one second.
    for (let i = 0; i < 120; i++) tick(1000 + i * (1000 / 120));
    const per_second = painted() - first;
    expect(MAX_FPS).toBe(30);
    expect(per_second).toBeLessThanOrEqual(MAX_FPS + 1);
    expect(per_second).toBeGreaterThanOrEqual(MAX_FPS - 6);
  });

  it("moves the world by real elapsed time, never by more than the step cap after a stall", async () => {
    const scene = await createCanvasScene(
      fakeContainer() as unknown as HTMLElement,
      config,
      deps(),
    );
    tick(1000);
    tick(1033);
    tick(60000); // the tab was asleep for a minute
    expect(MAX_STEP).toBe(0.1);
    scene.dispose();
  });

  it("pauses and resumes: no frames while paused, the idle gap dropped on resume", async () => {
    const scene = await createCanvasScene(
      fakeContainer() as unknown as HTMLElement,
      config,
      deps(),
    );
    tick(1000);
    scene.pause();
    expect(cancelled.length).toBeGreaterThan(0);
    const before = canvases[0].log.length;
    // A frame callback that was already queued must do nothing while paused.
    frames[0]?.(5000);
    expect(canvases[0].log.length).toBe(before);
    scene.pause(); // idempotent
    scene.resume();
    expect(frames.length).toBeGreaterThan(0);
    tick(100000);
    expect(canvases[0].log.length).toBeGreaterThan(before);
    scene.resume(); // idempotent
  });

  it("disposes: cancels the loop, stops listening and removes the canvas", async () => {
    const container = fakeContainer();
    const scene = await createCanvasScene(
      container as unknown as HTMLElement,
      config,
      deps(),
    );
    expect(observers).toHaveLength(1);
    scene.dispose();
    expect(container.children).toHaveLength(0);
    expect(stopped).toBe(1);
    // A size change after dispose does nothing.
    container.clientWidth = 900;
    observers[0]();
    expect(container.children).toHaveLength(0);
    const before = canvases[0].log.length;
    frames.forEach((f) => f(9999));
    expect(canvases[0].log.length).toBe(before);
    scene.pause();
    scene.resume();
    scene.dispose();
  });

  it("rebuilds for a new size when the container's box changes, window event or not", async () => {
    const container = fakeContainer(393, 640);
    await createCanvasScene(
      container as unknown as HTMLElement,
      config,
      deps(),
    );
    expect(canvases[0].raw.width).toBe(786);
    container.clientWidth = 820;
    observers[0]();
    expect(canvases[0].raw.width).toBe(1640);
    expect(canvases[0].log.some((l) => l === "rect(0,0,820,640)")).toBe(true);
    // A taller box rebuilds too (the hero or the card grew).
    container.clientHeight = 700;
    observers[0]();
    expect(canvases[0].raw.height).toBe(1400);
    expect(canvases[0].log.some((l) => l === "rect(0,0,820,700)")).toBe(true);
    // The same size, or a collapsed box, changes nothing.
    const n = canvases[0].log.length;
    observers[0]();
    container.clientHeight = 0;
    observers[0]();
    expect(canvases[0].log.length).toBe(n);
    expect(canvases[0].raw.height).toBe(1400);
  });

  it("does not throw out of the observer when a scene cannot be built: the effect goes away", async () => {
    const container = fakeContainer(393, 640);
    let calls = 0;
    const rng = () => {
      calls++;
      if (calls > 5000) throw new Error("rng failed");
      return 0.5;
    };
    const handle = await createCanvasScene(
      container as unknown as HTMLElement,
      config,
      { ...deps(), rng },
    );
    expect(container.children).toHaveLength(1);
    calls = 10000; // from now on every roll throws
    container.clientWidth = 820;
    expect(() => observers[0]()).not.toThrow();
    expect(container.children).toHaveLength(0);
    expect(stopped).toBe(1);
    handle.resume();
    handle.dispose();
  });
});
