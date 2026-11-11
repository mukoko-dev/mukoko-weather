import { describe, expect, it, vi } from "vitest";
import {
  TILE_RETRY_DELAYS_MS,
  fetchBytes,
  type FetchDeps,
} from "./smooth-tile-protocol";

const bytes = (n: number) => new Uint8Array([n]).buffer;
const ok = (n: number) => ({ ok: true, arrayBuffer: async () => bytes(n) });
const notOk = { ok: false, arrayBuffer: async () => bytes(0) };

/** Replies in order; the last reply repeats. Sleeps are recorded, not waited. */
function deps(replies: Array<unknown>) {
  let i = 0;
  const calls: string[] = [];
  const sleeps: number[] = [];
  const d: FetchDeps = {
    fetchFn: vi.fn(async (url: string) => {
      calls.push(url);
      const r = replies[Math.min(i++, replies.length - 1)];
      if (r instanceof Error) throw r;
      return r as Awaited<ReturnType<NonNullable<FetchDeps["fetchFn"]>>>;
    }),
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  return { d, calls, sleeps };
}

describe("fetchBytes (tile fetch with a short retry)", () => {
  it("returns the bytes of a tile that loads first time, without waiting", async () => {
    const { d, calls, sleeps } = deps([ok(7)]);
    const out = await fetchBytes("https://t.test/1.png", undefined, d);
    expect(new Uint8Array(out!)[0]).toBe(7);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("asks again after a 404 and returns the tile that then loads", async () => {
    const { d, calls, sleeps } = deps([notOk, ok(9)]);
    const out = await fetchBytes("https://t.test/1.png", undefined, d);
    expect(new Uint8Array(out!)[0]).toBe(9);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([TILE_RETRY_DELAYS_MS[0]]);
  });

  it("retries a network error the same way", async () => {
    const { d, calls } = deps([new TypeError("network"), notOk, ok(3)]);
    const out = await fetchBytes("https://t.test/1.png", undefined, d);
    expect(new Uint8Array(out!)[0]).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it("gives up after the last retry and says so with null", async () => {
    const { d, calls, sleeps } = deps([notOk]);
    const out = await fetchBytes("https://t.test/1.png", undefined, d);
    expect(out).toBeNull();
    expect(calls).toHaveLength(TILE_RETRY_DELAYS_MS.length + 1);
    expect(sleeps).toEqual([...TILE_RETRY_DELAYS_MS]);
  });

  it("stops at once when the request is aborted", async () => {
    const controller = new AbortController();
    const { d, calls } = deps([notOk]);
    d.fetchFn = vi.fn(async () => {
      controller.abort();
      calls.push("x");
      return notOk;
    });
    const out = await fetchBytes("https://t.test/1.png", controller.signal, d);
    expect(out).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("keeps the waits short enough for a map tile", () => {
    const total = TILE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(1000);
  });
});
