import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetStartGate,
  holdStorageForFirstScreen,
  isStorageHeld,
  releaseStorage,
  releaseStorageAfterPaint,
  storageMayStart,
  STORAGE_MAX_HOLD_MS,
} from "./start-gate";

/** A window whose frames and idle moments the test fires by hand. */
function fakeWindow() {
  const frames = new Map<number, () => void>();
  const idles = new Map<number, () => void>();
  let next = 1;
  vi.stubGlobal("window", {
    requestAnimationFrame: (cb: () => void) => {
      frames.set(next, cb);
      return next++;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    requestIdleCallback: (cb: () => void) => {
      idles.set(next, cb);
      return next++;
    },
    cancelIdleCallback: (id: number) => idles.delete(id),
  });
  return {
    frame() {
      const due = [...frames.values()];
      frames.clear();
      for (const cb of due) cb();
    },
    idle() {
      const due = [...idles.values()];
      idles.clear();
      for (const cb of due) cb();
    },
  };
}

/** Whether `p` has settled, after the microtasks queued so far. */
async function settled(p: Promise<void>): Promise<boolean> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetStartGate();
});
afterEach(() => {
  _resetStartGate();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("storageMayStart", () => {
  it("is open when nothing holds it back", async () => {
    fakeWindow();
    expect(await settled(storageMayStart())).toBe(true);
  });

  it("is held on the home page until released", async () => {
    fakeWindow();
    expect(isStorageHeld()).toBe(false);
    holdStorageForFirstScreen("/");
    expect(isStorageHeld()).toBe(true);
    const wait = storageMayStart();
    expect(await settled(wait)).toBe(false);
    releaseStorage();
    expect(isStorageHeld()).toBe(false);
    expect(await settled(wait)).toBe(true);
    // And open for good afterwards.
    expect(await settled(storageMayStart())).toBe(true);
  });

  it("is never held on another page: place pages and lists read storage to paint", async () => {
    fakeWindow();
    for (const path of ["/harare--ksy4dd1", "/locations", "/profile", "/map"]) {
      holdStorageForFirstScreen(path);
      expect(await settled(storageMayStart()), path).toBe(true);
    }
  });

  it("is never held on the server", async () => {
    // No window: nothing to hold back.
    holdStorageForFirstScreen("/");
    expect(await settled(storageMayStart())).toBe(true);
  });

  it("lets go by itself when the weather never paints", async () => {
    fakeWindow();
    holdStorageForFirstScreen("/");
    const wait = storageMayStart();
    await vi.advanceTimersByTimeAsync(STORAGE_MAX_HOLD_MS - 1);
    expect(await settled(wait)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(wait)).toBe(true);
  });

  it("releases every waiter at once", async () => {
    fakeWindow();
    holdStorageForFirstScreen("/");
    const waits = [storageMayStart(), storageMayStart(), storageMayStart()];
    releaseStorage();
    for (const w of waits) expect(await settled(w)).toBe(true);
  });
});

describe("releaseStorageAfterPaint", () => {
  it("lets go after two frames and an idle moment, not before", async () => {
    const w = fakeWindow();
    holdStorageForFirstScreen("/");
    const wait = storageMayStart();
    releaseStorageAfterPaint();
    expect(await settled(wait)).toBe(false);
    w.frame(); // the frame the render committed into
    w.idle();
    expect(await settled(wait)).toBe(false);
    w.frame(); // that frame has been presented
    expect(await settled(wait)).toBe(false);
    w.idle();
    expect(await settled(wait)).toBe(true);
  });

  it("does not let go once cancelled, but the time limit still does", async () => {
    const w = fakeWindow();
    holdStorageForFirstScreen("/");
    const wait = storageMayStart();
    const cancel = releaseStorageAfterPaint();
    cancel();
    w.frame();
    w.frame();
    w.idle();
    expect(await settled(wait)).toBe(false);
    await vi.advanceTimersByTimeAsync(STORAGE_MAX_HOLD_MS);
    expect(await settled(wait)).toBe(true);
  });

  it("a dashboard that paints before the gate is armed means it is never armed", async () => {
    // Child effects run before their parents', so the dashboard can ask first.
    const w = fakeWindow();
    releaseStorageAfterPaint();
    w.frame();
    w.frame();
    w.idle();
    holdStorageForFirstScreen("/");
    expect(await settled(storageMayStart())).toBe(true);
  });
});
