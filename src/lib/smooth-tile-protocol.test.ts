import { describe, expect, it, vi } from "vitest";
import {
  LruCache,
  SMOOTH_PROTOCOL,
  SMOOTH_TILE_SIZE,
  smoothTileUrl,
} from "./smooth-tile";
import {
  TILE_RETRY_DELAYS_MS,
  fetchBytes,
  loadSmoothTile,
  registerSmoothProtocol,
  sleepMs,
  type Decoded,
  type FetchResponse,
  type LoaderDeps,
} from "./smooth-tile-protocol";

const bytes = (n: number) => new Uint8Array([n]).buffer;
const res = (status: number, n = 1): FetchResponse => ({
  ok: status >= 200 && status < 300,
  status,
  arrayBuffer: async () => bytes(n),
});

type Reply = number | Error;

/**
 * A scripted network: replies per URL in order (the last repeats), calls and
 * sleeps recorded. Sleeping never waits.
 */
function network(script: Record<string, Reply[]> = {}, fallback: Reply = 200) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const used = new Map<string, number>();
  const deps: LoaderDeps = {
    fetchFn: async (url, init) => {
      calls.push(url);
      if (init?.signal?.aborted) throw new DOMException("x", "AbortError");
      const replies = script[url] ?? [fallback];
      const i = used.get(url) ?? 0;
      used.set(url, i + 1);
      const r = replies[Math.min(i, replies.length - 1)];
      if (r instanceof Error) throw r;
      return res(r, calls.length);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return {
    deps,
    calls,
    sleeps,
    count: (u: string) => calls.filter((c) => c === u).length,
  };
}

const TILE = (z: number, y: number, x: number) =>
  `https://gibs.example/wmts/L/default/T/M/${z}/${y}/${x}.png`;
const SMOOTH = (z: number, y: number, x: number) =>
  smoothTileUrl(TILE(z, y, x), 0.1);

/** A decoded 256 px tile with a few opaque pixels, so there is rain to smooth. */
function rainTile(): Decoded {
  const data = new Uint8ClampedArray(SMOOTH_TILE_SIZE * SMOOTH_TILE_SIZE * 4);
  for (let y = 100; y < 106; y++)
    for (let x = 100; x < 106; x++)
      data.set([30, 160, 40, 255], (y * SMOOTH_TILE_SIZE + x) * 4);
  return { size: SMOOTH_TILE_SIZE, data };
}

/** Deps for loadSmoothTile: scripted network, fake decoder and bitmap maker, fresh caches. */
function loader(net = network(), over: Partial<LoaderDeps> = {}) {
  const bitmaps: Array<{ side: number; close: ReturnType<typeof vi.fn> }> = [];
  const deps: LoaderDeps = {
    ...net.deps,
    decode: async () => rainTile(),
    toBitmap: async (_pixels, side) => {
      const b = { side, width: side, height: side, close: vi.fn() };
      bitmaps.push(b);
      return b as unknown as ImageBitmap;
    },
    bytes: new LruCache(400),
    decoded: new LruCache(24),
    ...over,
  };
  return { deps, net, bitmaps };
}

describe("fetchBytes (the retry policy)", () => {
  it("returns the bytes of a tile that loads first time, without waiting", async () => {
    const n = network();
    const out = await fetchBytes(TILE(6, 1, 1), undefined, n.deps, true);
    expect(new Uint8Array(out!)[0]).toBe(1);
    expect(n.calls).toHaveLength(1);
    expect(n.sleeps).toEqual([]);
  });

  it("asks again once after a 404 (GIBS answers existing tiles with one now and then)", async () => {
    const url = TILE(6, 1, 1);
    const n = network({ [url]: [404, 200] });
    expect(await fetchBytes(url, undefined, n.deps, true)).not.toBeNull();
    expect(n.sleeps).toEqual([TILE_RETRY_DELAYS_MS[0]]);
    // ...but only once: a tile that is really absent is not held for long.
    const gone = network({ [url]: [404] });
    expect(await fetchBytes(url, undefined, gone.deps, true)).toBeNull();
    expect(gone.calls).toHaveLength(2);
  });

  it("retries a 5xx, a 429 and a network error up to the listed delays", async () => {
    const url = TILE(6, 1, 1);
    const n = network({ [url]: [503, 429, 200] });
    expect(await fetchBytes(url, undefined, n.deps, true)).not.toBeNull();
    expect(n.sleeps).toEqual([...TILE_RETRY_DELAYS_MS]);
    const down = network({ [url]: [new TypeError("network")] });
    expect(await fetchBytes(url, undefined, down.deps, true)).toBeNull();
    expect(down.calls).toHaveLength(TILE_RETRY_DELAYS_MS.length + 1);
  });

  it("does not retry any other 4xx", async () => {
    const url = TILE(6, 1, 1);
    const n = network({ [url]: [403, 200] });
    expect(await fetchBytes(url, undefined, n.deps, true)).toBeNull();
    expect(n.calls).toHaveLength(1);
  });

  it("asks once when told not to retry (a neighbour), whatever the failure", async () => {
    const url = TILE(6, 1, 1);
    for (const reply of [404, 503, new TypeError("network")]) {
      const n = network({ [url]: [reply, 200] });
      expect(await fetchBytes(url, undefined, n.deps)).toBeNull();
      expect(n.calls).toHaveLength(1);
      expect(n.sleeps).toEqual([]);
    }
  });

  it("rejects with an AbortError when aborted before it starts, without asking", async () => {
    const c = new AbortController();
    c.abort();
    const n = network();
    await expect(
      fetchBytes(TILE(6, 1, 1), c.signal, n.deps),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(n.calls).toHaveLength(0);
  });

  it("rejects with an AbortError when aborted during the request", async () => {
    const c = new AbortController();
    const n = network();
    n.deps.fetchFn = async () => {
      c.abort();
      return res(503);
    };
    await expect(
      fetchBytes(TILE(6, 1, 1), c.signal, n.deps, true),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("sleepMs", () => {
  it("resolves at once when the signal is already aborted", async () => {
    const c = new AbortController();
    c.abort();
    const t = Date.now();
    await sleepMs(10_000, c.signal);
    expect(Date.now() - t).toBeLessThan(500);
  });

  it("resolves when the signal aborts during the wait, and after the delay without one", async () => {
    const c = new AbortController();
    const t = Date.now();
    const p = sleepMs(10_000, c.signal);
    setTimeout(() => c.abort(), 5);
    await p;
    expect(Date.now() - t).toBeLessThan(500);
    await sleepMs(5);
  });
});

describe("loadSmoothTile", () => {
  const signal = () => new AbortController().signal;

  it("rejects a URL that is not a smoothed tile address", async () => {
    const { deps } = loader();
    await expect(loadSmoothTile(TILE(6, 1, 1), signal(), deps)).rejects.toThrow(
      /not a smoothed tile/,
    );
    await expect(
      loadSmoothTile(
        `${SMOOTH_PROTOCOL}://0.1/https://x.test/no-tile`,
        signal(),
        deps,
      ),
    ).rejects.toThrow();
  });

  it("smooths the tile with its eight neighbours and returns the finer bitmap", async () => {
    const { deps, net, bitmaps } = loader();
    const out = await loadSmoothTile(SMOOTH(6, 35, 38), signal(), deps);
    expect(bitmaps).toHaveLength(1);
    expect(bitmaps[0].side).toBe(SMOOTH_TILE_SIZE * 2);
    expect(out.data).toBe(bitmaps[0] as unknown as ImageBitmap);
    // The nine tiles around (35, 38), each asked for once.
    expect(new Set(net.calls).size).toBe(9);
    expect(net.calls).toHaveLength(9);
    expect(net.calls).toContain(TILE(6, 34, 37));
    expect(net.calls).toContain(TILE(6, 36, 39));
  });

  it("shares neighbours between tiles: each is fetched once, not once per tile", async () => {
    const { deps, net } = loader();
    await loadSmoothTile(SMOOTH(6, 35, 38), signal(), deps);
    await loadSmoothTile(SMOOTH(6, 35, 39), signal(), deps);
    // 9 tiles for the first, then only the 3 new ones (the column east of the first's east neighbours).
    expect(net.calls).toHaveLength(12);
    expect(net.count(TILE(6, 35, 39))).toBe(1); // already fetched as a neighbour
    expect(net.count(TILE(6, 34, 38))).toBe(1);
  });

  it("does not hold a tile back for a neighbour that is missing, and does not retry it", async () => {
    const missing = TILE(6, 36, 38);
    const { deps, net, bitmaps } = loader(network({ [missing]: [404] }));
    const out = await loadSmoothTile(SMOOTH(6, 35, 38), signal(), deps);
    expect(out.data).toBe(bitmaps[0] as unknown as ImageBitmap);
    expect(net.count(missing)).toBe(1);
    expect(net.sleeps).toEqual([]);
  });

  it("does not poison the cache with a failed neighbour: the next tile asks again", async () => {
    const missing = TILE(6, 36, 38);
    const { deps, net } = loader(network({ [missing]: [404, 200] }));
    await loadSmoothTile(SMOOTH(6, 35, 38), signal(), deps);
    await loadSmoothTile(SMOOTH(6, 35, 37), signal(), deps); // (36, 38) is a neighbour of this one too
    expect(net.count(missing)).toBe(2);
  });

  it("rejects when the tile itself never loads, with an ordinary error", async () => {
    const own = TILE(6, 35, 38);
    const { deps, net } = loader(network({ [own]: [404] }));
    const err = await loadSmoothTile(SMOOTH(6, 35, 38), signal(), deps).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).not.toBe("AbortError");
    expect(net.count(own)).toBe(2); // one 404 retry
  });

  it("rejects with an AbortError when aborted before it starts", async () => {
    const c = new AbortController();
    c.abort();
    const { deps, net } = loader();
    await expect(
      loadSmoothTile(SMOOTH(6, 35, 38), c.signal, deps),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(net.calls).toHaveLength(0);
  });

  it("rejects with an AbortError when aborted while the neighbours load", async () => {
    const c = new AbortController();
    const net = network();
    const inner = net.deps.fetchFn!;
    net.deps.fetchFn = async (url, init) => {
      if (url !== TILE(6, 35, 38)) c.abort(); // the centre loads, then the user moves on
      return inner(url, init);
    };
    const { deps, bitmaps } = loader(net);
    await expect(
      loadSmoothTile(SMOOTH(6, 35, 38), c.signal, deps),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(bitmaps).toHaveLength(0);
  });

  it("rejects with an AbortError, and frees the bitmap, when aborted while it is made", async () => {
    const c = new AbortController();
    const closed = vi.fn();
    const { deps } = loader(undefined, {
      toBitmap: async (_p, side) => {
        c.abort();
        return {
          close: closed,
          width: side,
          height: side,
        } as unknown as ImageBitmap;
      },
    });
    await expect(
      loadSmoothTile(SMOOTH(6, 35, 38), c.signal, deps),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("gives back the provider's own bytes when the browser cannot decode or draw", async () => {
    const decoders: Array<NonNullable<LoaderDeps["decode"]>> = [
      async () => null,
      async () => {
        throw new Error("no canvas");
      },
      async () => ({ size: 128, data: new Uint8ClampedArray(128 * 128 * 4) }),
    ];
    for (const decode of decoders) {
      const { deps, bitmaps } = loader(undefined, { decode });
      const out = await loadSmoothTile(SMOOTH(6, 35, 38), signal(), deps);
      expect(out.data).toBeInstanceOf(ArrayBuffer);
      expect(bitmaps).toHaveLength(0);
    }
  });

  it("gives back the provider's own bytes when the bitmap cannot be made", async () => {
    const { deps } = loader(undefined, {
      toBitmap: async () => {
        throw new Error("no bitmap");
      },
    });
    const out = await loadSmoothTile(SMOOTH(6, 35, 38), signal(), deps);
    expect(out.data).toBeInstanceOf(ArrayBuffer);
  });
});

describe("registerSmoothProtocol", () => {
  type Handler = (
    p: { url: string },
    c: AbortController,
  ) => Promise<{ data: unknown }>;

  it("registers mksmooth once per addProtocol and hands tiles to the loader", async () => {
    const add = vi.fn();
    const { deps, bitmaps } = loader();
    registerSmoothProtocol(add, deps);
    registerSmoothProtocol(add, deps);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0]).toBe(SMOOTH_PROTOCOL);

    const handler = add.mock.calls[0][1] as Handler;
    const out = await handler(
      { url: SMOOTH(6, 35, 38) },
      new AbortController(),
    );
    expect(out.data).toBe(bitmaps[0]);

    // A different addProtocol (another MapLibre) registers again.
    const other = vi.fn();
    registerSmoothProtocol(other, deps);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("passes MapLibre's abort controller through", async () => {
    const add = vi.fn();
    const { deps } = loader();
    registerSmoothProtocol(add, deps);
    const handler = add.mock.calls[0][1] as Handler;
    const c = new AbortController();
    c.abort();
    await expect(handler({ url: SMOOTH(6, 35, 38) }, c)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
