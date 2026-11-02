import { describe, it, expect, vi } from "vitest";
import { TIMED_OUT, withTimeout } from "./with-timeout";

describe("withTimeout", () => {
  it("resolves with the work when it finishes in time", async () => {
    expect(await withTimeout(Promise.resolve(7), 50)).toBe(7);
  });

  it("rejects with the work's own error when it fails in time", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("boom")), 50),
    ).rejects.toThrow("boom");
  });

  it("resolves to TIMED_OUT when the work hangs, and does not wait for it", async () => {
    const started = Date.now();
    const result = await withTimeout(new Promise<number>(() => undefined), 20);
    expect(result).toBe(TIMED_OUT);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("swallows a rejection that arrives after giving up (no unhandled rejection)", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    let reject!: (e: Error) => void;
    const work = new Promise<number>((_res, rej) => (reject = rej));
    expect(await withTimeout(work, 10)).toBe(TIMED_OUT);
    reject(new Error("late"));
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("clears its timer", async () => {
    vi.useFakeTimers();
    try {
      await withTimeout(Promise.resolve(1), 10_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
