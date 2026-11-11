/**
 * Tomorrow.io capacity detection (#542): how the map learns, from one tile,
 * that the tiles Worker has only its blank placeholder to give, and what it
 * shows instead. The fetch and the clock are injected, so every rule here runs
 * without a browser or a network. The placeholder's bytes are read from the
 * Worker's own source, so the detection is tied to the real thing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  CAPACITY_PROBE_TIMEOUT_MS,
  CAPACITY_RECHECK_FLOOR_MS,
  CAPACITY_VERDICT_TTL_MS,
  busySubject,
  capacityNoteText,
  capacityState,
  createCapacityProbe,
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

/** The Worker's 68-byte placeholder, parsed out of weather-core's source. */
function workerPlaceholder(): Uint8Array {
  const source = readFileSync(
    resolve(__dirname, "../../workers/crates/weather-core/src/tiles.rs"),
    "utf-8",
  );
  const decl = source.slice(source.indexOf("pub const TRANSPARENT_PNG"));
  const body = decl.slice(decl.indexOf("= [") + 3, decl.indexOf("];"));
  const bytes = [
    ...body.replace(/\/\/.*$/gm, "").matchAll(/0x([0-9A-Fa-f]{2})/g),
  ];
  return Uint8Array.from(bytes.map((m) => parseInt(m[1], 16)));
}

/** A PNG header for a `width` x `height` picture (enough for the size check). */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function response(
  init: {
    status?: number;
    headers?: Record<string, string>;
    body?: Uint8Array;
  } = {},
): ProbeResponse {
  const status = init.status ?? 200;
  const headers = new Map(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    arrayBuffer: async () => {
      const body = init.body ?? pngHeader(256, 256);
      return body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength,
      ) as ArrayBuffer;
    },
  };
}

const BLANK = (): ProbeResponse =>
  response({ headers: { "X-Map-Tile": "empty" }, body: workerPlaceholder() });
const REAL = (): ProbeResponse =>
  response({ headers: { "X-Cache": "HIT", "X-Map-Layer": "temperature" } });

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
  it("holds a Tomorrow.io layer until its first answer", () => {
    expect(capacityState("precipitationIntensity", null)).toEqual({
      layer: "precipitationIntensity",
      busy: false,
      held: true,
    });
  });

  it("swaps a busy Tomorrow.io layer for the default, whichever of the four", () => {
    for (const id of [
      "precipitationIntensity",
      "temperature",
      "windSpeed",
      "cloudCover",
    ]) {
      expect(capacityState(id, "busy")).toEqual({
        layer: DEFAULT_LAYER,
        busy: true,
        held: false,
      });
    }
  });

  it("keeps the layer when a tile came back, or when the answer could not be read", () => {
    for (const verdict of ["live", "unknown"] as const) {
      expect(capacityState("temperature", verdict)).toEqual({
        layer: "temperature",
        busy: false,
        held: false,
      });
    }
  });

  it("never holds or swaps a layer that needs no Tomorrow.io tile", () => {
    for (const id of [DEFAULT_LAYER, "airQuality", "wildfire", "modelWind"]) {
      for (const verdict of [null, "live", "busy", "unknown"] as const) {
        expect(capacityState(id, verdict)).toEqual({
          layer: id,
          busy: false,
          held: false,
        });
      }
    }
  });

  it("the layer it falls back to is one of the chips, and is not a Tomorrow.io layer", () => {
    expect(MAP_CHIPS.some((c) => c.id === DEFAULT_LAYER)).toBe(true);
    expect(isTomorrowLayer(DEFAULT_LAYER)).toBe(false);
    // A different fallback can be asked for.
    expect(capacityState("windSpeed", "busy", "wildfire").layer).toBe(
      "wildfire",
    );
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

  function harness(answer: () => ProbeResponse | Promise<ProbeResponse>) {
    let t = 1_000_000;
    const calls: string[] = [];
    const probe = createCapacityProbe({
      now: () => t,
      fetch: async (url) => {
        calls.push(url);
        return answer();
      },
    });
    return { probe, calls, advance: (ms: number) => (t += ms) };
  }

  it("asks for ONE tile of the layer: the one under the place, from the tiles Worker", async () => {
    const { probe, calls } = harness(BLANK);
    expect(
      await probe.check({ layer: "precipitationIntensity", ...place }),
    ).toBe("busy");
    expect(calls).toEqual([
      `${WEATHER_TILES_ORIGIN}/v1/map-tiles?z=8&x=150&y=140&layer=precipitationIntensity`,
    ]);
  });

  it("answers from memory for a minute: no request, however often it is asked", async () => {
    const { probe, calls, advance } = harness(BLANK);
    await probe.check({ layer: "temperature", ...place });
    for (let i = 0; i < 20; i++) {
      advance(1_000);
      expect(await probe.check({ layer: "temperature", ...place })).toBe(
        "busy",
      );
    }
    expect(calls).toHaveLength(1);
    // 20 s later: still inside the minute.
    expect(CAPACITY_VERDICT_TTL_MS).toBe(60_000);
  });

  it("asks the browser's cache normally, but never takes 'Try again' from it (the placeholder is kept 30 s)", async () => {
    const inits: unknown[] = [];
    let t = 0;
    const probe = createCapacityProbe({
      now: () => t,
      fetch: async (_url, init) => {
        inits.push(init?.cache);
        return BLANK();
      },
    });
    await probe.check({ layer: "temperature", ...place });
    t += CAPACITY_RECHECK_FLOOR_MS;
    await probe.check({ layer: "temperature", ...place, force: true });
    expect(inits).toEqual(["default", "no-cache"]);
  });

  it("shares a request already in flight instead of sending another", async () => {
    let release: (r: ProbeResponse) => void = () => {};
    const { probe, calls } = harness(
      () => new Promise<ProbeResponse>((resolve) => (release = resolve)),
    );
    const first = probe.check({ layer: "windSpeed", ...place });
    const second = probe.check({ layer: "windSpeed", ...place });
    const forced = probe.check({ layer: "windSpeed", ...place, force: true });
    release(BLANK());
    expect(await Promise.all([first, second, forced])).toEqual([
      "busy",
      "busy",
      "busy",
    ]);
    expect(calls).toHaveLength(1);
  });

  it("asks once per layer, not once for all four", async () => {
    const { probe, calls } = harness(REAL);
    for (const layer of [
      "precipitationIntensity",
      "temperature",
      "windSpeed",
    ]) {
      await probe.check({ layer, ...place });
      await probe.check({ layer, ...place });
    }
    expect(calls).toHaveLength(3);
  });

  it("forgets the verdict after a minute, so a layer works again with no code change", async () => {
    let busy = true;
    const { probe, calls, advance } = harness(() => (busy ? BLANK() : REAL()));
    expect(await probe.check({ layer: "cloudCover", ...place })).toBe("busy");
    busy = false; // the provider is back
    advance(CAPACITY_VERDICT_TTL_MS - 1);
    expect(await probe.check({ layer: "cloudCover", ...place })).toBe("busy");
    advance(1);
    expect(await probe.check({ layer: "cloudCover", ...place })).toBe("live");
    expect(calls).toHaveLength(2);
  });

  it("'Try again' skips the minute but not the floor between real requests", async () => {
    const { probe, calls, advance } = harness(BLANK);
    await probe.check({ layer: "temperature", ...place });
    advance(CAPACITY_RECHECK_FLOOR_MS - 1);
    // Tapped again straight away: answered from memory, not another request.
    expect(
      await probe.check({ layer: "temperature", ...place, force: true }),
    ).toBe("busy");
    expect(calls).toHaveLength(1);
    advance(1);
    await probe.check({ layer: "temperature", ...place, force: true });
    expect(calls).toHaveLength(2);
    // Without the tap, the minute still applies.
    advance(CAPACITY_RECHECK_FLOOR_MS);
    await probe.check({ layer: "temperature", ...place });
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
    expect(await probe.check({ layer: "temperature", ...place })).toBe(
      "unknown",
    );
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
