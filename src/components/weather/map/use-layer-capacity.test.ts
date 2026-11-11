/**
 * useLayerCapacity (#542), run for real: the hook is rendered with the real
 * React DOM reconciler (src/lib/test-render.ts: effects, state, StrictMode),
 * against a probe with a mocked `fetch` and a controlled clock. The probe's own
 * rules are in src/lib/map-capacity.test.ts; these check what the hook does
 * with them: who asks, when, and what the map is told.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPACITY_RECHECK_FLOOR_MS,
  CAPACITY_VERDICT_TTL_MS,
  createCapacityProbe,
  type ProbeResponse,
} from "@/lib/map-capacity";
import { BLANK, REAL } from "@/lib/map-capacity-fixtures";
import { DEFAULT_LAYER } from "@/lib/map-layers";
import { act, renderHook } from "@/lib/test-render";
import { useLayerCapacity } from "./use-layer-capacity";

const FOUR = [
  "precipitationIntensity",
  "temperature",
  "windSpeed",
  "cloudCover",
];

/** A probe over a fake tiles host whose answer a test can change, with the clock faked. */
function setup() {
  let answer: () => ProbeResponse | Promise<ProbeResponse> = BLANK;
  const requests: { url: string; cache?: RequestCache }[] = [];
  const probe = createCapacityProbe({
    fetch: async (url, init) => {
      requests.push({ url, cache: init?.cache });
      return answer();
    },
  });
  const announce = vi.fn();
  const restoreFocus = vi.fn();
  type Props = { layer: string; lat?: number };
  const hook = (props: Props) =>
    useLayerCapacity({
      layer: props.layer,
      lat: props.lat ?? -17.83,
      lon: 31.05,
      mapZoom: 8,
      probe,
      announce,
      restoreFocus,
    });
  const waiting: ((r: ProbeResponse) => void)[] = [];
  return {
    probe,
    requests,
    announce,
    restoreFocus,
    hook,
    answerWith: (next: typeof answer) => (answer = next),
    /** From now on a request stays out until `release` is called. */
    hold: () => {
      answer = () => new Promise((resolve) => waiting.push(resolve));
    },
    /** Answers every request that is out. */
    release: (response: ProbeResponse) =>
      act(async () => {
        for (const resolve of waiting.splice(0)) resolve(response);
      }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useLayerCapacity: who asks", () => {
  it("holds a Tomorrow.io layer's overlay back, then shows the default when the one tile says busy", async () => {
    const t = setup();
    t.hold();
    const { result } = await renderHook(t.hook, {
      initialProps: { layer: "precipitationIntensity" },
    });
    // The effect ran, the request is out and not yet answered.
    expect(result.current).toMatchObject({
      layer: "precipitationIntensity",
      held: true,
      checking: true,
      busy: false,
    });
    await t.release(BLANK());
    expect(result.current).toMatchObject({
      layer: DEFAULT_LAYER,
      busy: true,
      held: false,
      checking: false,
    });
    expect(t.requests).toHaveLength(1);
  });

  it("never asks, holds or swaps for the default layer or any other keyless one", async () => {
    for (const layer of [
      DEFAULT_LAYER,
      "airQuality",
      "wildfire",
      "modelWind",
    ]) {
      const t = setup();
      const { result, unmount } = await renderHook(t.hook, {
        initialProps: { layer },
      });
      expect(result.current).toMatchObject({
        layer,
        held: false,
        busy: false,
        checking: false,
      });
      expect(t.requests).toHaveLength(0);
      await unmount();
    }
  });

  it("sends ONE request in StrictMode, where effects run twice", async () => {
    const t = setup();
    await renderHook(t.hook, {
      initialProps: { layer: "temperature" },
      strict: true,
    });
    await act(async () => {});
    expect(t.requests).toHaveLength(1);
  });

  it("shares the verdict between the four layers: switching chips sends nothing and flickers nothing", async () => {
    const t = setup();
    const { result, rerender } = await renderHook(t.hook, {
      initialProps: { layer: "precipitationIntensity" },
    });
    await act(async () => {});
    expect(t.requests).toHaveLength(1);
    for (const layer of [...FOUR, ...FOUR]) {
      await rerender({ layer });
      // Busy at once: never the "no answer yet" frame that would blank the map.
      expect(result.current).toMatchObject({
        layer: DEFAULT_LAYER,
        busy: true,
        held: false,
      });
    }
    expect(t.requests).toHaveLength(1);
  });

  it("an answer for one layer is the answer for the next layer chosen before it arrives", async () => {
    const t = setup();
    let release: (r: ProbeResponse) => void = () => {};
    t.answerWith(() => new Promise((resolve) => (release = resolve)));
    const { result, rerender } = await renderHook(t.hook, {
      initialProps: { layer: "precipitationIntensity" },
    });
    await rerender({ layer: "windSpeed" });
    // Still one request, still waiting.
    expect(t.requests).toHaveLength(1);
    expect(result.current).toMatchObject({ layer: "windSpeed", held: true });
    await act(async () => release(BLANK()));
    expect(result.current).toMatchObject({ layer: DEFAULT_LAYER, busy: true });
    expect(t.requests).toHaveLength(1);
  });

  it("an answer that arrives after the person moved to a keyless layer changes nothing on screen, and is there when they come back", async () => {
    const t = setup();
    let release: (r: ProbeResponse) => void = () => {};
    t.answerWith(() => new Promise((resolve) => (release = resolve)));
    const { result, rerender } = await renderHook(t.hook, {
      initialProps: { layer: "temperature" },
    });
    await rerender({ layer: DEFAULT_LAYER });
    await act(async () => release(BLANK()));
    expect(result.current).toMatchObject({
      layer: DEFAULT_LAYER,
      busy: false,
      held: false,
    });
    // Back to a live layer inside the minute: busy at once, no second request.
    await rerender({ layer: "cloudCover" });
    expect(result.current).toMatchObject({ layer: DEFAULT_LAYER, busy: true });
    expect(t.requests).toHaveLength(1);
  });

  it("asks again, on a layer change, only once the verdict is a minute old", async () => {
    const t = setup();
    const { result, rerender } = await renderHook(t.hook, {
      initialProps: { layer: "temperature" },
    });
    await act(async () => {});
    t.hold();
    await act(async () => {
      vi.advanceTimersByTime(CAPACITY_VERDICT_TTL_MS - 1_000);
    });
    await rerender({ layer: "windSpeed" });
    expect(t.requests).toHaveLength(1);
    expect(result.current.busy).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await rerender({ layer: "cloudCover" });
    // The old verdict is asked about again: the fallback stays until the answer.
    expect(t.requests).toHaveLength(2);
    expect(result.current).toMatchObject({
      layer: DEFAULT_LAYER,
      busy: true,
      checking: true,
    });
    await t.release(REAL());
    expect(result.current).toMatchObject({
      layer: "cloudCover",
      busy: false,
      held: false,
    });
  });

  it("does not ask by itself: an open tab on the fallback stays there until someone acts", async () => {
    const t = setup();
    const { result } = await renderHook(t.hook, {
      initialProps: { layer: "precipitationIntensity" },
    });
    await act(async () => {});
    t.answerWith(REAL); // the provider is back, but nobody has looked
    await act(async () => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(t.requests).toHaveLength(1);
    expect(result.current).toMatchObject({ layer: DEFAULT_LAYER, busy: true });
  });
});

describe("useLayerCapacity: Try again", () => {
  async function busyHook(layer = "precipitationIntensity") {
    const t = setup();
    const rendered = await renderHook(t.hook, { initialProps: { layer } });
    await act(async () => {});
    return { t, ...rendered };
  }

  it("sends exactly ONE real request, and the force is used up by it", async () => {
    const { t, result, rerender } = await busyHook();
    await act(async () => {
      vi.advanceTimersByTime(CAPACITY_RECHECK_FLOOR_MS);
    });
    await act(async () => {
      await result.current.recheck();
    });
    expect(t.requests.map((r) => r.cache)).toEqual(["default", "no-cache"]);
    // Now switch layers every 15 s for a while: no tap, so no request and no
    // forced (uncached, short-memory) look, however many times.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        vi.advanceTimersByTime(15_000);
      });
      await rerender({ layer: FOUR[(i + 1) % 4] });
      await rerender({ layer: FOUR[(i + 2) % 4] });
    }
    // 45 s later it is still inside the minute the tap's answer started.
    expect(t.requests).toHaveLength(2);
  });

  it("a layer change after the minute is a plain look, not forced", async () => {
    const { t, result, rerender } = await busyHook();
    await act(async () => {
      vi.advanceTimersByTime(CAPACITY_RECHECK_FLOOR_MS);
    });
    await act(async () => {
      await result.current.recheck();
    });
    await act(async () => {
      vi.advanceTimersByTime(CAPACITY_VERDICT_TTL_MS);
    });
    await rerender({ layer: "windSpeed" });
    expect(t.requests.map((r) => r.cache)).toEqual([
      "default",
      "no-cache",
      "default",
    ]);
  });

  it("inside the floor it is answered from memory, says so for as long as the wait lasts, and sends nothing", async () => {
    const { t, result } = await busyHook();
    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });
    let outcome: Awaited<ReturnType<typeof result.current.recheck>> | undefined;
    await act(async () => {
      outcome = await result.current.recheck();
    });
    expect(outcome).toEqual({
      verdict: "busy",
      asked: false,
      retryAfterMs: CAPACITY_RECHECK_FLOOR_MS - 4_000,
    });
    expect(t.requests).toHaveLength(1);
    expect(result.current.recent).toBe(true);
    expect(t.announce).toHaveBeenLastCalledWith("Checked a moment ago.");
    // The words go back to "Try again" when a real request is allowed again.
    await act(async () => {
      vi.advanceTimersByTime(CAPACITY_RECHECK_FLOOR_MS - 4_000);
    });
    expect(result.current.recent).toBe(false);
  });

  it("shows the fallback while it asks, and brings the layer back, says so, and moves focus, when the tile is real", async () => {
    const { t, result, doc } = await busyHook("temperature");
    t.hold();
    await act(async () => {
      vi.advanceTimersByTime(CAPACITY_RECHECK_FLOOR_MS);
    });
    // Focus was on the "Try again" button, which goes away with the note.
    doc.activeElement = null;
    await act(async () => {
      void result.current.recheck();
    });
    expect(result.current).toMatchObject({
      layer: DEFAULT_LAYER,
      busy: true,
      rechecking: true,
    });
    await t.release(REAL());
    expect(result.current).toMatchObject({
      layer: "temperature",
      busy: false,
      held: false,
      rechecking: false,
    });
    expect(t.announce).toHaveBeenLastCalledWith(
      "Live temperature map is back.",
    );
    expect(t.restoreFocus).toHaveBeenCalledTimes(1);
  });

  it("does not take focus from where it is when the layer returns on its own", async () => {
    const { t, result, doc } = await busyHook("temperature");
    t.answerWith(REAL);
    const elsewhere = doc.createElement("button");
    doc.body.appendChild(elsewhere);
    elsewhere.focus();
    await act(async () => {
      vi.advanceTimersByTime(CAPACITY_RECHECK_FLOOR_MS);
    });
    await act(async () => {
      await result.current.recheck();
    });
    expect(t.restoreFocus).not.toHaveBeenCalled();
    expect(doc.activeElement).toBe(elsewhere);
  });

  it("says it is still busy, and stays on the fallback, when the tile is blank again", async () => {
    const { t, result } = await busyHook("windSpeed");
    await act(async () => {
      vi.advanceTimersByTime(CAPACITY_RECHECK_FLOOR_MS);
    });
    await act(async () => {
      await result.current.recheck();
    });
    expect(result.current).toMatchObject({ layer: DEFAULT_LAYER, busy: true });
    expect(t.announce).toHaveBeenLastCalledWith("Live wind map is still busy.");
    expect(t.restoreFocus).not.toHaveBeenCalled();
  });
});

describe("useLayerCapacity: what is said", () => {
  it("announces the swap, once for each change and not on every render", async () => {
    const t = setup();
    const { rerender } = await renderHook(t.hook, {
      initialProps: { layer: "precipitationIntensity" },
    });
    await act(async () => {});
    expect(t.announce).toHaveBeenCalledTimes(1);
    expect(t.announce).toHaveBeenCalledWith(
      "Live rain radar is busy right now. Showing satellite instead.",
    );
    // A re-render with nothing new says nothing more.
    await rerender();
    expect(t.announce).toHaveBeenCalledTimes(1);
    // The layer asked for changes while the fallback stays: say what it is now.
    await rerender({ layer: "temperature" });
    expect(t.announce).toHaveBeenCalledTimes(2);
    expect(t.announce).toHaveBeenLastCalledWith(
      "Live temperature map is busy right now. Showing satellite instead.",
    );
  });

  it("does not call choosing a keyless layer by hand 'coming back'", async () => {
    const t = setup();
    const { rerender } = await renderHook(t.hook, {
      initialProps: { layer: "precipitationIntensity" },
    });
    await act(async () => {});
    t.announce.mockClear();
    await rerender({ layer: DEFAULT_LAYER });
    expect(t.announce).not.toHaveBeenCalled();
    expect(t.restoreFocus).not.toHaveBeenCalled();
  });
});
