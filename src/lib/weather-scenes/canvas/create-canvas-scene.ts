/**
 * The 2D canvas version of `createWeatherScene`, for iPhone and iPad (see
 * `backdropMode`): a `<canvas>` in the container, one effect per weather scene
 * (`scenes.ts`), the same `WeatherSceneHandle` as the Three.js scene so
 * `WeatherBackdrop` pauses it the same way (tab hidden, while scrolling, once
 * the sky is scrolled away).
 *
 * What keeps it cheap on a phone: no WebGL context, no extra script (it is a few
 * kilobytes in the same chunk), at most 30 frames a second, a pixel ratio capped
 * at the caller's `maxPixelRatio` (never above 2), a canvas only as big as the
 * hero region, and a loop that is stopped whenever nobody can see it.
 * Everything is clipped to the canvas, which is the effect's boundary. The
 * canvas follows its container: whenever the container's box changes size (a
 * `ResizeObserver`, not only a window resize) the scene is built again for the
 * new box, and a container that has no size yet starts the effect when it gets
 * one.
 *
 * Decorative: the canvas is `aria-hidden`. Any failure (no 2D context, a scene
 * that cannot be built) leaves the still sky.
 */

import { getScenePalette, SPRITE_MASK } from "../palette";
import type { WeatherSceneConfig, WeatherSceneHandle } from "../types";
import type { Rng } from "./random";
import {
  buildCanvasScene,
  type Canvas2D,
  type CanvasScene,
  type SpriteSource,
} from "./scenes";

/** At most this many frames a second. */
export const MAX_FPS = 30;
/** The pixel ratio is never above this, whatever the screen reports. */
export const MAX_PIXEL_RATIO = 2;
/** A frame after a long stall moves the world this much at most, in seconds. */
export const MAX_STEP = 0.1;

const SPRITE_SIZE = 64;

/** What the factory needs from the page; tests pass fakes. */
export interface CanvasSceneDeps {
  createCanvas(): HTMLCanvasElement;
  raf(cb: (now: number) => void): number;
  caf(id: number): void;
  pixelRatio(): number;
  /**
   * Call `cb` whenever the element's box may have changed size; returns the
   * function that stops it. The browser one is a `ResizeObserver`, with the
   * window `resize` event where there is none.
   */
  observe(el: HTMLElement, cb: () => void): () => void;
  rng: Rng;
}

const browserDeps: CanvasSceneDeps = {
  createCanvas: () => document.createElement("canvas"),
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id),
  pixelRatio: () => window.devicePixelRatio || 1,
  observe: (el, cb) => {
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => cb());
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener("resize", cb, { passive: true });
    return () => window.removeEventListener("resize", cb);
  },
  rng: Math.random,
};

/**
 * Soft round sprites, one per colour, made once on a small offscreen canvas: a
 * white radial falloff tinted by `source-in`. Drawing a sprite scaled is far
 * cheaper per frame than building a gradient per cloud puff.
 */
function spriteSource(deps: CanvasSceneDeps): SpriteSource {
  const cache = new Map<string, HTMLCanvasElement>();
  return (color) => {
    const hit = cache.get(color);
    if (hit) return hit;
    const c = deps.createCanvas();
    c.width = SPRITE_SIZE;
    c.height = SPRITE_SIZE;
    const g = c.getContext("2d");
    if (g) {
      const grad = g.createRadialGradient(
        SPRITE_SIZE / 2,
        SPRITE_SIZE / 2,
        0,
        SPRITE_SIZE / 2,
        SPRITE_SIZE / 2,
        SPRITE_SIZE / 2,
      );
      grad.addColorStop(0, SPRITE_MASK.core);
      grad.addColorStop(0.45, SPRITE_MASK.mid);
      grad.addColorStop(1, SPRITE_MASK.edge);
      g.fillStyle = grad;
      g.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
      g.globalCompositeOperation = "source-in";
      g.fillStyle = color;
      g.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
    }
    cache.set(color, c);
    return c;
  };
}

/**
 * Create the 2D effect for `config.type` in `container`. Resolves to a handle
 * that pauses, resumes and disposes it.
 */
export async function createCanvasScene(
  container: HTMLElement,
  config: WeatherSceneConfig,
  deps: CanvasSceneDeps = browserDeps,
): Promise<WeatherSceneHandle> {
  const noop: WeatherSceneHandle = { dispose() {}, pause() {}, resume() {} };

  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null;
  try {
    canvas = deps.createCanvas();
    ctx = canvas.getContext("2d");
  } catch {
    return noop;
  }
  if (!ctx) return noop;
  const g = ctx;

  canvas.className = "absolute inset-0 h-full w-full";
  canvas.setAttribute("aria-hidden", "true");

  const maxRatio = Math.min(
    config.maxPixelRatio ?? MAX_PIXEL_RATIO,
    MAX_PIXEL_RATIO,
  );
  const sprites = spriteSource(deps);

  let width = 0;
  let height = 0;
  let dpr = 1;
  let scene: CanvasScene | null = null;
  let disposed = false;
  let paused = false;
  let frameId = 0;
  let last = 0;
  let elapsed = 0;
  const minGap = 1000 / MAX_FPS;

  /** Size the canvas to the box and build a fresh scene for it. May throw. */
  const build = (w: number, h: number) => {
    const ratio = Math.min(deps.pixelRatio(), maxRatio);
    const palette = getScenePalette(config.type, config.isDay, config.phase);
    const next = buildCanvasScene({
      type: config.type,
      size: { w, h },
      palette,
      isDay: config.isDay,
      phase: config.phase,
      windSpeed: config.windSpeed,
      rng: deps.rng,
    });
    dpr = ratio;
    width = w;
    height = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    scene = next;
  };

  const paint = () => {
    const s = scene;
    if (!s) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    g.save();
    // The boundary: nothing is ever drawn outside the box.
    g.beginPath();
    g.rect(0, 0, width, height);
    g.clip();
    s.draw(g as unknown as Canvas2D, sprites);
    g.restore();
    g.globalAlpha = 1;
  };

  const frame = (now: number) => {
    const s = scene;
    if (disposed || paused || !s) return;
    frameId = deps.raf(frame);
    if (last !== 0 && now - last < minGap - 2) return;
    const dt = last === 0 ? 0 : Math.min((now - last) / 1000, MAX_STEP);
    last = now;
    elapsed += dt;
    s.step(dt, elapsed);
    paint();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    deps.caf(frameId);
    stopObserving();
    if (container.contains(canvas)) container.removeChild(canvas);
  };

  /**
   * The box is measured at the start and again whenever it changes size. The
   * first usable size starts the effect; a later one builds it again for the
   * new box; a box with no size (not laid out yet, or hidden) waits.
   */
  const handleSize = () => {
    if (disposed) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0 || (w === width && h === height)) return;
    const starting = scene === null;
    try {
      build(w, h);
    } catch {
      // A scene that cannot be built leaves the still sky.
      dispose();
      return;
    }
    if (starting) container.appendChild(canvas);
    paint();
    if (starting && !paused) frameId = deps.raf(frame);
  };

  const stopObserving = deps.observe(container, handleSize);
  handleSize();

  return {
    dispose,
    pause() {
      if (disposed || paused) return;
      paused = true;
      deps.caf(frameId);
    },
    resume() {
      if (disposed || !paused) return;
      paused = false;
      last = 0; // drop the idle gap so motion resumes smoothly
      if (scene) frameId = deps.raf(frame);
    },
  };
}
