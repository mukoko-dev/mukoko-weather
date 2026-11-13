/**
 * The sky's still rain streaks and stars, rendered: they go once a live
 * animated layer draws the same thing, so the hero never shows two rains (or
 * two sets of stars), and they stay for a sky that does not move. And when the
 * animated layer starts: not until the weather has painted and the browser is
 * idle (start-gate.ts), so its 715 KB does not load in the middle of start-up.
 *
 * Unlike the source-reading tests in WeatherBackdrop.test.ts, these RENDER the
 * real backdrop with the real React DOM (src/lib/test-render.ts) and replace
 * only the two scene factories (what would draw into a WebGL or 2D canvas),
 * the device policy and the start gate, so the tests choose the mode, whether
 * the layer is drawing and when the gate opens. Not here: WebGL, layout and
 * CSS; the live-site check is in the PR.
 */
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, mount, type Mounted } from "@/lib/test-render";
import { WeatherBackdrop } from "@/components/weather/WeatherBackdrop";

const layer = vi.hoisted(() => ({
  mode: "webgl" as "webgl" | "canvas" | "static",
  live: true,
}));

// The start gate: open at once, unless a test holds it to look at the moment
// before the weather has painted and the browser is idle.
const gate = vi.hoisted(() => ({
  hold: false,
  pending: [] as Array<() => void>,
  cancelled: 0,
  asked: 0,
}));
const scene = vi.hoisted(() => ({ webgl: 0, canvas: 0 }));

const handle = () => ({
  live: layer.live,
  dispose() {},
  pause() {},
  resume() {},
});

vi.mock("@/lib/weather-scenes", async (original) => {
  const actual = await original<typeof import("@/lib/weather-scenes")>();
  return {
    ...actual,
    createWeatherScene: async () => {
      scene.webgl++;
      return handle();
    },
  };
});
vi.mock("@/lib/weather-scenes/canvas/create-canvas-scene", () => ({
  createCanvasScene: async () => {
    scene.canvas++;
    return handle();
  },
}));
vi.mock("@/lib/weather-scenes/start-gate", () => ({
  afterPaintWhenIdle: (start: () => void) => {
    gate.asked++;
    if (!gate.hold) {
      start();
      return () => {};
    }
    gate.pending.push(start);
    return () => {
      gate.cancelled++;
      gate.pending = gate.pending.filter((s) => s !== start);
    };
  },
}));
vi.mock("@/lib/weather-scenes/backdrop-policy", async (original) => {
  const actual =
    await original<typeof import("@/lib/weather-scenes/backdrop-policy")>();
  return {
    ...actual,
    backdropMode: () => layer.mode,
    readBackdropHints: () => ({ reducedMotion: false }),
  };
});

// WMO codes: 61 slight rain, 95 thunderstorm, 0 clear, 2 partly cloudy, 3 overcast.
const RAIN = 61;
const STORM = 95;
const CLEAR = 0;
const PARTLY = 2;
const OVERCAST = 3;

let mounted: Mounted | undefined;

/** Renders the backdrop and lets the mode and the layer's start settle. */
async function sky(weatherCode: number, isDay: boolean, windSpeed = 8) {
  // The render helper's requestAnimationFrame is a timer; its pair is not stubbed.
  vi.stubGlobal("cancelAnimationFrame", (id: number) =>
    clearTimeout(id as unknown as Parameters<typeof clearTimeout>[0]),
  );
  mounted = await mount(
    createElement(WeatherBackdrop, { weatherCode, isDay, windSpeed }),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const has = (cls: string) => mounted!.find({ class: cls }).length > 0;
  return { streaks: has("kestrel-streaks"), stars: has("kestrel-stars") };
}

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  layer.mode = "webgl";
  layer.live = true;
  gate.hold = false;
  gate.pending = [];
  gate.cancelled = 0;
  gate.asked = 0;
  scene.webgl = 0;
  scene.canvas = 0;
});

describe("the hero draws one rain", () => {
  it("drops the still streaks under a live 3D rain", async () => {
    expect((await sky(RAIN, true)).streaks).toBe(false);
  });

  it("drops the still streaks under a live 3D thunderstorm", async () => {
    expect((await sky(STORM, true)).streaks).toBe(false);
  });

  it("drops the still streaks under a live 2D rain (iPhone and iPad)", async () => {
    layer.mode = "canvas";
    expect((await sky(RAIN, true)).streaks).toBe(false);
  });

  it("keeps the still streaks when the layer did not start (WebGL or canvas failed)", async () => {
    layer.live = false;
    expect((await sky(RAIN, true)).streaks).toBe(true);
  });

  it("keeps the still streaks when nothing moves (reduced motion, Save-Data, low memory)", async () => {
    layer.mode = "static";
    expect((await sky(RAIN, true)).streaks).toBe(true);
    expect((await sky(STORM, true)).streaks).toBe(true);
  });
});

describe("the night sky draws one set of stars", () => {
  it("drops the still stars under the live 3D clear night, which draws its own", async () => {
    expect((await sky(CLEAR, false)).stars).toBe(false);
  });

  it("keeps the still stars under a 3D cloudy or partly-cloudy night, which draws none", async () => {
    expect((await sky(OVERCAST, false)).stars).toBe(true);
    await mounted?.unmount();
    expect((await sky(PARTLY, false)).stars).toBe(true);
  });

  it("keeps the still stars on a clear night turned windy, which draws none", async () => {
    expect((await sky(CLEAR, false, 55)).stars).toBe(true);
  });

  it("drops them under the 2D clear and partly-cloudy nights, and keeps them under the 2D cloudy night", async () => {
    layer.mode = "canvas";
    expect((await sky(CLEAR, false)).stars).toBe(false);
    await mounted?.unmount();
    expect((await sky(PARTLY, false)).stars).toBe(false);
    await mounted?.unmount();
    expect((await sky(OVERCAST, false)).stars).toBe(true);
  });

  it("keeps the still stars when the layer did not start, or nothing moves", async () => {
    layer.live = false;
    expect((await sky(CLEAR, false)).stars).toBe(true);
    await mounted?.unmount();
    layer.live = true;
    layer.mode = "static";
    expect((await sky(CLEAR, false)).stars).toBe(true);
  });
});

describe("a sky with no still texture", () => {
  it("has neither layer by day without rain, and snow never had one", async () => {
    expect(await sky(CLEAR, true)).toEqual({ streaks: false, stars: false });
  });
});

describe("the animated layer waits for the weather to paint and the browser to idle", () => {
  /** Mount with the gate held, and let the mode settle. */
  async function held(weatherCode = RAIN, isDay = true) {
    gate.hold = true;
    return sky(weatherCode, isDay);
  }

  it("loads nothing before the gate opens, and the still sky shows meanwhile", async () => {
    const before = await held();
    expect(scene.webgl).toBe(0);
    expect(scene.canvas).toBe(0);
    expect(gate.pending).toHaveLength(1);
    // The same sky and its still rain, so nothing is blank or moves when the
    // layer arrives.
    expect(
      mounted!.find({
        class: "kestrel-reach pointer-events-none z-0 overflow-hidden",
      }),
    ).toHaveLength(1);
    expect(before.streaks).toBe(true);
  });

  it("loads the 3D layer once the gate opens, and the still streaks go under it", async () => {
    await held();
    await act(async () => {
      gate.pending.forEach((start) => start());
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(scene.webgl).toBe(1);
    expect(mounted!.find({ class: "kestrel-streaks" })).toHaveLength(0);
  });

  it("gates the 2D layer the same way (iPhone and iPad)", async () => {
    layer.mode = "canvas";
    await held();
    expect(scene.canvas).toBe(0);
    await act(async () => {
      gate.pending.forEach((start) => start());
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(scene.canvas).toBe(1);
    expect(scene.webgl).toBe(0);
  });

  it("never schedules a start for a sky that does not move (reduced motion, Save-Data, low memory)", async () => {
    layer.mode = "static";
    await held();
    expect(gate.asked).toBe(0);
    expect(gate.pending).toHaveLength(0);
    expect(scene.webgl + scene.canvas).toBe(0);
  });

  it("cancels the start when the page goes before the gate opens", async () => {
    await held();
    await mounted?.unmount();
    mounted = undefined;
    expect(gate.cancelled).toBe(1);
    expect(gate.pending).toHaveLength(0);
    expect(scene.webgl).toBe(0);
  });

  it("arms the gate once: a change of scene while it waits does not push it back", async () => {
    await held(CLEAR, true);
    expect(gate.asked).toBe(1);
    await mounted!.rerender(
      createElement(WeatherBackdrop, {
        weatherCode: RAIN,
        isDay: true,
        windSpeed: 8,
      }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // Still the one gate, still waiting, and nothing created yet.
    expect(gate.asked).toBe(1);
    expect(gate.cancelled).toBe(0);
    expect(gate.pending).toHaveLength(1);
    expect(scene.webgl).toBe(0);
    // When it opens, the scene that is current by then is the one that starts.
    await act(async () => {
      gate.pending.forEach((start) => start());
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(scene.webgl).toBe(1);
  });

  it("restarts for a new scene at once: only the first start waits", async () => {
    await held(CLEAR, true);
    await act(async () => {
      gate.pending.forEach((start) => start());
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(scene.webgl).toBe(1);
    expect(gate.asked).toBe(1);

    await mounted!.rerender(
      createElement(WeatherBackdrop, {
        weatherCode: RAIN,
        isDay: true,
        windSpeed: 8,
      }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(scene.webgl).toBe(2);
    expect(gate.pending).toHaveLength(0);
  });
});
