import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  afterPaintWhenIdle,
  FALLBACK_POLL_MS,
  FALLBACK_QUIET_POLLS,
  START_IDLE_TIMEOUT_MS,
} from "./start-gate";

/** A window whose frames and idle moments the test fires by hand. */
function fakeWindow(opts: { idle: boolean }) {
  const frames = new Map<number, () => void>();
  const idles = new Map<number, { cb: () => void; timeout?: number }>();
  let next = 1;
  const win: Record<string, unknown> = {
    requestAnimationFrame: (cb: () => void) => {
      frames.set(next, cb);
      return next++;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  };
  if (opts.idle) {
    win.requestIdleCallback = (cb: () => void, o?: { timeout: number }) => {
      idles.set(next, { cb, timeout: o?.timeout });
      return next++;
    };
    win.cancelIdleCallback = (id: number) => idles.delete(id);
  }
  vi.stubGlobal("window", win);
  return {
    /** Fire the frames queued right now (not ones they queue). */
    frame() {
      const due = [...frames.entries()];
      frames.clear();
      for (const [, cb] of due) cb();
    },
    pendingFrames: () => frames.size,
    pendingIdles: () => idles.size,
    idle() {
      const due = [...idles.values()];
      idles.clear();
      for (const { cb } of due) cb();
    },
    idleTimeouts: () => [...idles.values()].map((i) => i.timeout),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("afterPaintWhenIdle", () => {
  it("does nothing until two frames have passed, then waits for an idle moment", () => {
    const w = fakeWindow({ idle: true });
    const start = vi.fn();
    afterPaintWhenIdle(start);

    expect(start).not.toHaveBeenCalled();
    expect(w.pendingIdles()).toBe(0);
    w.frame(); // the frame the render committed into
    expect(start).not.toHaveBeenCalled();
    expect(w.pendingIdles()).toBe(0);
    w.frame(); // that frame has been presented
    expect(start).not.toHaveBeenCalled();
    expect(w.pendingIdles()).toBe(1);
    w.idle();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("asks for the idle moment with a timeout, so a busy page still gets its sky", () => {
    const w = fakeWindow({ idle: true });
    afterPaintWhenIdle(() => {});
    w.frame();
    w.frame();
    expect(w.idleTimeouts()).toEqual([START_IDLE_TIMEOUT_MS]);
  });

  it("takes the caller's timeout", () => {
    const w = fakeWindow({ idle: true });
    afterPaintWhenIdle(() => {}, 750);
    w.frame();
    w.frame();
    expect(w.idleTimeouts()).toEqual([750]);
  });

  it("starts once and only once", () => {
    const w = fakeWindow({ idle: true });
    const start = vi.fn();
    afterPaintWhenIdle(start);
    w.frame();
    w.frame();
    w.idle();
    w.idle();
    w.frame();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("where the browser has no requestIdleCallback, starts after on-time polls of a quiet main thread", () => {
    const w = fakeWindow({ idle: false });
    const start = vi.fn();
    afterPaintWhenIdle(start);
    w.frame();
    w.frame();
    const quietFor = FALLBACK_POLL_MS * FALLBACK_QUIET_POLLS;
    vi.advanceTimersByTime(quietFor - 1);
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("where the browser has no requestIdleCallback, a busy main thread keeps waiting, up to the timeout", () => {
    const w = fakeWindow({ idle: false });
    const start = vi.fn();
    afterPaintWhenIdle(start, 1000);
    w.frame();
    w.frame();
    // Every poll fires 100 ms late: the main thread is never quiet.
    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(Date.now() + 100);
      vi.advanceTimersByTime(FALLBACK_POLL_MS);
    }
    expect(start).not.toHaveBeenCalled();
    // The timeout is the upper bound.
    for (let i = 0; i < 20 && start.mock.calls.length === 0; i++) {
      vi.setSystemTime(Date.now() + 100);
      vi.advanceTimersByTime(FALLBACK_POLL_MS);
    }
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("where the browser has no requestIdleCallback, one late poll resets the count of quiet ones", () => {
    const w = fakeWindow({ idle: false });
    const start = vi.fn();
    afterPaintWhenIdle(start);
    w.frame();
    w.frame();
    vi.advanceTimersByTime(FALLBACK_POLL_MS); // quiet: 1
    vi.setSystemTime(Date.now() + 100);
    vi.advanceTimersByTime(FALLBACK_POLL_MS); // late: back to 0
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FALLBACK_POLL_MS); // quiet: 1
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FALLBACK_POLL_MS); // quiet: 2
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("never starts in a tab that draws no frames (hidden)", () => {
    const w = fakeWindow({ idle: true });
    const start = vi.fn();
    afterPaintWhenIdle(start);
    vi.advanceTimersByTime(60_000);
    expect(start).not.toHaveBeenCalled();
    expect(w.pendingIdles()).toBe(0);
  });

  it("is cancelled by the canceller at every step", () => {
    // Before the first frame.
    let w = fakeWindow({ idle: true });
    let start = vi.fn();
    let cancel = afterPaintWhenIdle(start);
    cancel();
    w.frame();
    w.frame();
    w.idle();
    expect(start).not.toHaveBeenCalled();

    // Between the two frames.
    w = fakeWindow({ idle: true });
    start = vi.fn();
    cancel = afterPaintWhenIdle(start);
    w.frame();
    cancel();
    w.frame();
    expect(w.pendingIdles()).toBe(0);
    expect(start).not.toHaveBeenCalled();

    // While waiting for the idle moment.
    w = fakeWindow({ idle: true });
    start = vi.fn();
    cancel = afterPaintWhenIdle(start);
    w.frame();
    w.frame();
    expect(w.pendingIdles()).toBe(1);
    cancel();
    expect(w.pendingIdles()).toBe(0);
    w.idle();
    expect(start).not.toHaveBeenCalled();

    // While waiting on the Safari timer.
    w = fakeWindow({ idle: false });
    start = vi.fn();
    cancel = afterPaintWhenIdle(start);
    w.frame();
    w.frame();
    cancel();
    vi.advanceTimersByTime(10_000);
    expect(start).not.toHaveBeenCalled();
  });
});
