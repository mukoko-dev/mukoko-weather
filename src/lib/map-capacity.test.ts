/**
 * Tomorrow.io capacity detection (#542): how the map learns, from one tile,
 * that the tiles Worker has only its blank placeholder to give, and what it
 * shows instead. The fetch and the clock are injected, so every rule here runs
 * without a browser or a network. The placeholder's bytes are read from the
 * Worker's own source, so the detection is tied to the real thing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPACITY_PROBE_TIMEOUT_MS,
  CAPACITY_RECHECK_FLOOR_MS,
  CAPACITY_VERDICT_TTL_MS,
  busySubject,
  capacityNoteText,
  capacityState,
  createCapacityProbe,
  fallbackLayerLabel,
  isPlaceholderPng,
  isTomorrowLayer,
  probeTileFor,
  probeTileUrl,
  verdictFromResponse,
  type ProbeResponse,
} from "./map-capacity";
import {
  DEFAULT_LAYER,
  MAP_CHIPS,
  WEATHER_OVERLAY_MAX_ZOOM,
  WEATHER_OVERLAY_MIN_ZOOM,
  WEATHER_TILES_ORIGIN,
} from "./map-layers";
import {
  BLANK,
  REAL,
  pngHeader,
  probeResponse as response,
  workerPlaceholder,
} from "./map-capacity-fixtures";

afterEach(() => {
  vi.useRealTimers();
});

describe("isTomorrowLayer", () => {
  it("is true for the four Tomorrow.io chips", () => {
    for (const id of [
      "precipitationIntensity",
      "temperature",
      "windSpeed",
      "cloudCover",
    ]) {
      expect(isTomorrowLayer(id)).toBe(true);
    }
  });

  it("is false for every layer that needs no Tomorrow.io tile", () => {
    for (const id of [
      DEFAULT_LAYER,
      "satellite",
      "satelliteRain",
      "wildfire",
      "airQuality",
      "modelTemperature",
      "modelPrecipitation",
      "modelWind",
      "",
    ]) {
      expect(isTomorrowLayer(id)).toBe(false);
    }
    expect(isTomorrowLayer(null)).toBe(false);
    expect(isTomorrowLayer(undefined)).toBe(false);
  });
});

describe("probeTileFor", () => {
  it("is the tile under the place, at the map's own zoom (512 px tiles)", () => {
    // Harare, map zoom 8: x = floor((31.0522 + 180) / 360 * 256) = 150.
    expect(probeTileFor(-17.8292, 31.0522, 8)).toEqual({
      z: 8,
      x: 150,
      y: 140,
    });
  });

  it("stays inside the overlay's zoom range", () => {
    expect(probeTileFor(0, 0, 14).z).toBe(WEATHER_OVERLAY_MAX_ZOOM);
    expect(probeTileFor(0, 0, 0.4).z).toBe(WEATHER_OVERLAY_MIN_ZOOM);
  });

  it("clamps the antimeridian and the poles into the tile grid", () => {
    const edge = probeTileFor(89, 180, 8);
    expect(edge.x).toBe(255);
    expect(edge.y).toBe(0);
    expect(probeTileFor(-89, -180, 8)).toEqual({ z: 8, x: 0, y: 255 });
  });
});

describe("probeTileUrl", () => {
  it("is the layer's 'now' tile on the tiles Worker, with no timestamp", () => {
    const url = probeTileUrl("precipitationIntensity", {
      z: 8,
      x: 150,
      y: 140,
    });
    expect(url).toBe(
      `${WEATHER_TILES_ORIGIN}/v1/map-tiles?z=8&x=150&y=140&layer=precipitationIntensity`,
    );
    expect(url).not.toContain("timestamp");
    expect(url).not.toContain("{");
  });
});

describe("isPlaceholderPng", () => {
  it("recognises the tiles Worker's own 68-byte placeholder", () => {
    const placeholder = workerPlaceholder();
    expect(placeholder).toHaveLength(68);
    expect(isPlaceholderPng(placeholder)).toBe(true);
  });

  it("does not take a real tile for it", () => {
    expect(isPlaceholderPng(pngHeader(256, 256))).toBe(false);
    expect(isPlaceholderPng(pngHeader(512, 512))).toBe(false);
    // One side of one pixel is not the placeholder.
    expect(isPlaceholderPng(pngHeader(1, 256))).toBe(false);
  });

  it("ignores anything that is not a PNG, or too short to say", () => {
    expect(isPlaceholderPng(new Uint8Array(0))).toBe(false);
    expect(isPlaceholderPng(new Uint8Array(23))).toBe(false);
    expect(isPlaceholderPng(new Uint8Array(40))).toBe(false);
    expect(
      isPlaceholderPng(new TextEncoder().encode("<html>busy</html>   x")),
    ).toBe(false);
  });
});

describe("verdictFromResponse", () => {
  it("reads X-Map-Tile: empty as busy, without reading the picture", async () => {
    const res = response({ headers: { "X-Map-Tile": "empty" } });
    res.arrayBuffer = () => Promise.reject(new Error("body must not be read"));
    expect(await verdictFromResponse(res)).toBe("busy");
  });

  it("reads the header whatever its case", async () => {
    expect(
      await verdictFromResponse(
        response({ headers: { "x-map-tile": "EMPTY" } }),
      ),
    ).toBe("busy");
  });

  it("reads a 1x1 picture as busy when the header did not get through", async () => {
    expect(
      await verdictFromResponse(response({ body: workerPlaceholder() })),
    ).toBe("busy");
  });

  it("reads a real tile as live", async () => {
    expect(await verdictFromResponse(REAL())).toBe("live");
    // A stale tile (older data, still data) is live too.
    expect(
      await verdictFromResponse(response({ headers: { "X-Cache": "STALE" } })),
    ).toBe("live");
  });

  it("reads the Worker's limit and outage answers as busy", async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(await verdictFromResponse(response({ status }))).toBe("busy");
    }
  });

  it("does not guess from other answers (a bad request is ours, not a quota)", async () => {
    for (const status of [400, 404, 422]) {
      expect(await verdictFromResponse(response({ status }))).toBe("unknown");
    }
    expect(
      await verdictFromResponse(response({ body: new Uint8Array(0) })),
    ).toBe("unknown");
  });
});

describe("capacityState", () => {
  const nothing = { verdict: null, inFlight: false } as const;

  it("holds a Tomorrow.io layer until its first answer", () => {
    expect(capacityState("precipitationIntensity", nothing)).toEqual({
      layer: "precipitationIntensity",
      busy: false,
      held: true,
      checking: false,
    });
    // ...and says it is checking only once a request is really out.
    expect(
      capacityState("precipitationIntensity", {
        verdict: null,
        inFlight: true,
      }),
    ).toMatchObject({ held: true, checking: true });
  });

  it("swaps a busy Tomorrow.io layer for the default, whichever of the four", () => {
    for (const id of [
      "precipitationIntensity",
      "temperature",
      "windSpeed",
      "cloudCover",
    ]) {
      expect(capacityState(id, { verdict: "busy", inFlight: false })).toEqual({
        layer: DEFAULT_LAYER,
        busy: true,
        held: false,
        checking: false,
      });
    }
  });

  it("keeps the fallback on screen while a busy verdict is asked again", () => {
    expect(
      capacityState("temperature", { verdict: "busy", inFlight: true }),
    ).toEqual({
      layer: DEFAULT_LAYER,
      busy: true,
      held: false,
      checking: true,
    });
  });

  it("keeps the layer when a tile came back, or when the answer could not be read", () => {
    for (const verdict of ["live", "unknown"] as const) {
      expect(
        capacityState("temperature", { verdict, inFlight: false }),
      ).toEqual({
        layer: "temperature",
        busy: false,
        held: false,
        checking: false,
      });
    }
  });

  it("holds the overlay again while an expired verdict is asked again", () => {
    expect(
      capacityState("temperature", { verdict: "live", inFlight: true }),
    ).toEqual({
      layer: "temperature",
      busy: false,
      held: true,
      checking: true,
    });
  });

  it("never holds or swaps a layer that needs no Tomorrow.io tile", () => {
    for (const id of [DEFAULT_LAYER, "airQuality", "wildfire", "modelWind"]) {
      for (const verdict of [null, "live", "busy", "unknown"] as const) {
        for (const inFlight of [false, true]) {
          expect(capacityState(id, { verdict, inFlight })).toEqual({
            layer: id,
            busy: false,
            held: false,
            checking: false,
          });
        }
      }
    }
  });

  it("the layer it falls back to is one of the chips, and is not a Tomorrow.io layer", () => {
    expect(MAP_CHIPS.some((c) => c.id === DEFAULT_LAYER)).toBe(true);
    expect(isTomorrowLayer(DEFAULT_LAYER)).toBe(false);
    // A different fallback can be asked for.
    expect(
      capacityState(
        "windSpeed",
        { verdict: "busy", inFlight: false },
        "wildfire",
      ).layer,
    ).toBe("wildfire");
  });
});

describe("the note's words", () => {
  it("names the layer and what is shown instead, plainly", () => {
    expect(capacityNoteText("precipitationIntensity", "Satellite")).toBe(
      "Live rain radar is busy right now. Showing satellite instead.",
    );
    expect(capacityNoteText("windSpeed", "Satellite")).toBe(
      "Live wind map is busy right now. Showing satellite instead.",
    );
    expect(fallbackLayerLabel()).toBe("Satellite");
  });

  it("has a subject for each chip that can be busy, and a safe one for any other", () => {
    expect(busySubject("temperature")).toBe("Live temperature map");
    expect(busySubject("cloudCover")).toBe("Live cloud map");
    expect(busySubject("somethingNew")).toBe("Live weather");
  });

  it("blames no one and shows no code", () => {
    const text = capacityNoteText("temperature", "Satellite");
    expect(text).not.toMatch(/error|fail|quota|429|503|tomorrow|worker/i);
  });
});

describe("createCapacityProbe", () => {
  const place = { lat: -17.8292, lon: 31.0522, mapZoom: 8 };
  const FOUR = [
    "precipitationIntensity",
    "temperature",
    "windSpeed",
    "cloudCover",
  ];

  function harness(answer: () => ProbeResponse | Promise<ProbeResponse>) {
    let t = 1_000_000;
    const calls: { url: string; cache?: RequestCache }[] = [];
    const probe = createCapacityProbe({
      now: () => t,
      fetch: async (url, init) => {
        calls.push({ url, cache: init?.cache });
        return answer();
      },
    });
    return { probe, calls, advance: (ms: number) => (t += ms) };
  }

  it("asks for ONE tile: the one under the place, from the tiles Worker", async () => {
    const { probe, calls } = harness(BLANK);
    expect(
      await probe.check({ layer: "precipitationIntensity", ...place }),
    ).toBe("busy");
    expect(calls.map((c) => c.url)).toEqual([
      `${WEATHER_TILES_ORIGIN}/v1/map-tiles?z=8&x=150&y=140&layer=precipitationIntensity`,
    ]);
  });

  it("has ONE verdict for all four layers: the quota is one key, so a minute's asking covers them all", async () => {
    const { probe, calls, advance } = harness(BLANK);
    // Switching between the four chips, over and over, within the minute.
    for (let round = 0; round < 3; round++) {
      for (const layer of FOUR) {
        expect(await probe.check({ layer, ...place })).toBe("busy");
        advance(1_000);
      }
    }
    expect(calls).toHaveLength(1);
  });

  it("a live verdict from any of the four is live for all four", async () => {
    const { probe, calls } = harness(REAL);
    expect(await probe.check({ layer: "windSpeed", ...place })).toBe("live");
    for (const layer of FOUR)
      expect(await probe.check({ layer, ...place })).toBe("live");
    expect(calls).toHaveLength(1);
  });

  it("answers from memory up to the minute, and asks again after it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T10:00:00Z"));
    let answer: () => ProbeResponse = BLANK;
    const calls: string[] = [];
    // The real clock and the default settings, not injected ones.
    const probe = createCapacityProbe({
      fetch: async (url) => {
        calls.push(url);
        return answer();
      },
    });
    expect(await probe.check({ layer: "temperature", ...place })).toBe("busy");
    answer = REAL; // the provider is back
    vi.setSystemTime(new Date("2026-11-11T10:00:59Z"));
    expect(await probe.check({ layer: "temperature", ...place })).toBe("busy");
    expect(calls).toHaveLength(1);
    vi.setSystemTime(new Date("2026-11-11T10:01:01Z"));
    expect(await probe.check({ layer: "temperature", ...place })).toBe("live");
    expect(calls).toHaveLength(2);
  });

  it("never asks by itself: nothing is sent while nobody calls it, however long it is left", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const probe = createCapacityProbe({
      fetch: async (url) => {
        calls.push(url);
        return BLANK();
      },
    });
    await probe.check({ layer: "temperature", ...place });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(calls).toHaveLength(1);
    // The old verdict is still what it knows; it is not asked about again.
    expect(probe.getSnapshot()).toEqual({ verdict: "busy", inFlight: false });
  });

  it("shares a request already in flight instead of sending another, across layers", async () => {
    let release: (r: ProbeResponse) => void = () => {};
    const { probe, calls } = harness(
      () => new Promise<ProbeResponse>((resolve) => (release = resolve)),
    );
    const first = probe.check({ layer: "windSpeed", ...place });
    const second = probe.check({ layer: "temperature", ...place });
    const tapped = probe.recheck({ layer: "cloudCover", ...place });
    expect(probe.getSnapshot()).toEqual({ verdict: null, inFlight: true });
    release(BLANK());
    expect(await Promise.all([first, second])).toEqual(["busy", "busy"]);
    expect(await tapped).toMatchObject({ verdict: "busy", asked: false });
    expect(calls).toHaveLength(1);
  });

  it("asks the browser's cache normally, but never takes 'Try again' from it (the placeholder is kept 30 s)", async () => {
    const { probe, calls, advance } = harness(BLANK);
    await probe.check({ layer: "temperature", ...place });
    advance(CAPACITY_RECHECK_FLOOR_MS);
    await probe.recheck({ layer: "temperature", ...place });
    expect(calls.map((c) => c.cache)).toEqual(["default", "no-cache"]);
  });

  it("'Try again' skips the minute but not the floor, and says whether it asked", async () => {
    const { probe, calls, advance } = harness(BLANK);
    await probe.check({ layer: "temperature", ...place });
    advance(CAPACITY_RECHECK_FLOOR_MS - 1_000);
    // Tapped inside the floor: answered from memory, with the wait that is left.
    expect(await probe.recheck({ layer: "temperature", ...place })).toEqual({
      verdict: "busy",
      asked: false,
      retryAfterMs: 1_000,
    });
    expect(calls).toHaveLength(1);
    advance(1_000);
    expect(await probe.recheck({ layer: "temperature", ...place })).toEqual({
      verdict: "busy",
      asked: true,
      retryAfterMs: CAPACITY_RECHECK_FLOOR_MS,
    });
    expect(calls).toHaveLength(2);
  });

  it("'Try again' updates the one verdict for every layer, and is not remembered as a forced ask", async () => {
    let busy = true;
    const { probe, calls, advance } = harness(() => (busy ? BLANK() : REAL()));
    await probe.check({ layer: "precipitationIntensity", ...place });
    busy = false;
    advance(CAPACITY_RECHECK_FLOOR_MS);
    await probe.recheck({ layer: "precipitationIntensity", ...place });
    expect(calls).toHaveLength(2);
    // Every layer now reads live, from memory; a later plain check is not forced.
    advance(20_000);
    for (const layer of FOUR)
      expect(await probe.check({ layer, ...place })).toBe("live");
    expect(calls).toHaveLength(2);
  });

  it("never retries a failure: a network error is a verdict, kept like any other", async () => {
    const calls: string[] = [];
    let t = 0;
    const probe = createCapacityProbe({
      now: () => t,
      fetch: async (url) => {
        calls.push(url);
        throw new TypeError("Failed to fetch");
      },
    });
    expect(await probe.check({ layer: "temperature", ...place })).toBe(
      "unknown",
    );
    expect(await probe.check({ layer: "windSpeed", ...place })).toBe("unknown");
    t += CAPACITY_VERDICT_TTL_MS - 1;
    await probe.check({ layer: "temperature", ...place });
    expect(calls).toHaveLength(1);
  });

  it("gives up on a tile that does not answer, and lets the map go on", async () => {
    vi.useFakeTimers();
    const probe = createCapacityProbe({
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    });
    const verdict = probe.check({ layer: "temperature", ...place });
    await vi.advanceTimersByTimeAsync(CAPACITY_PROBE_TIMEOUT_MS);
    expect(await verdict).toBe("unknown");
    expect(probe.getSnapshot()).toEqual({
      verdict: "unknown",
      inFlight: false,
    });
  });

  it("drops a late answer to a request that was given up on", async () => {
    vi.useFakeTimers();
    let late: (r: ProbeResponse) => void = () => {};
    // This fetch ignores the abort, like a stuck connection.
    const probe = createCapacityProbe({
      fetch: () => new Promise((resolve) => (late = resolve)),
    });
    const verdict = probe.check({ layer: "temperature", ...place });
    await vi.advanceTimersByTimeAsync(CAPACITY_PROBE_TIMEOUT_MS);
    expect(await verdict).toBe("unknown");
    late(BLANK());
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.getSnapshot()).toEqual({
      verdict: "unknown",
      inFlight: false,
    });
  });

  it("never asks about a layer that is not a Tomorrow.io one", async () => {
    const { probe, calls } = harness(BLANK);
    expect(await probe.check({ layer: "satellite", ...place })).toBe("unknown");
    expect(await probe.recheck({ layer: "airQuality", ...place })).toEqual({
      verdict: "unknown",
      asked: false,
      retryAfterMs: 0,
    });
    expect(calls).toHaveLength(0);
    expect(probe.getSnapshot()).toEqual({ verdict: null, inFlight: false });
  });

  it("tells subscribers when a request goes out and when it is answered, and stops when they leave", async () => {
    const { probe } = harness(BLANK);
    const seen: unknown[] = [];
    const stop = probe.subscribe(() => seen.push(probe.getSnapshot()));
    await probe.check({ layer: "temperature", ...place });
    expect(seen).toEqual([
      { verdict: null, inFlight: true },
      { verdict: "busy", inFlight: false },
    ]);
    stop();
    await probe.recheck({ layer: "temperature", ...place });
    expect(seen).toHaveLength(2);
  });

  it("the view is the same object until something changes (what useSyncExternalStore needs)", async () => {
    const { probe } = harness(BLANK);
    expect(probe.getSnapshot()).toBe(probe.getSnapshot());
    expect(probe.getServerSnapshot()).toBe(probe.getServerSnapshot());
    await probe.check({ layer: "temperature", ...place });
    const settled = probe.getSnapshot();
    await probe.check({ layer: "windSpeed", ...place }); // from memory
    expect(probe.getSnapshot()).toBe(settled);
  });

  it("each probe has its own memory", async () => {
    const a = harness(BLANK);
    const b = harness(REAL);
    expect(await a.probe.check({ layer: "temperature", ...place })).toBe(
      "busy",
    );
    expect(await b.probe.check({ layer: "temperature", ...place })).toBe(
      "live",
    );
  });
});
