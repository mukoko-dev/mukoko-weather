import { describe, it, expect, vi } from "vitest";
import {
  LIVE_EVENT_MIN_GAP_MS,
  LIVE_RATE_LIMITED_DEFAULT_MS,
  LIVE_RETRY_AFTER_CAP_MS,
  LIVE_RETRY_DELAYS_MS,
  createLiveFetch,
  retryDelayMs,
  type AttemptResult,
  type LiveFetchState,
} from "./live-fetch";
import type { WorkerFailure } from "./worker-data";

const server: WorkerFailure = { kind: "server", status: 503 };
const timeout: WorkerFailure = { kind: "timeout", status: 0 };
const offline: WorkerFailure = { kind: "offline", status: 0 };
const invalid: WorkerFailure = { kind: "invalid", status: 400 };
const limited = (retryAfterSeconds?: number): WorkerFailure => ({
  kind: "rate_limited",
  status: 429,
  ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
});

/** A manual clock and scheduler: nothing runs until the test says so. */
function harness<T = string>(script: Array<AttemptResult<T>>) {
  let t = 1_000_000;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const states: LiveFetchState[] = [];
  const values: T[] = [];
  const failures: Array<[WorkerFailure, number]> = [];
  const attempts: Array<{ attempt: number; force: boolean }> = [];
  let next = 0;
  const gates: Array<() => void> = [];
  let hold = false;

  const fetchLive = createLiveFetch<T>({
    attempt: async (info) => {
      attempts.push(info);
      if (hold) await new Promise<void>((r) => gates.push(r));
      const out = script[Math.min(next, script.length - 1)];
      next++;
      return out;
    },
    onValue: (v) => values.push(v),
    onState: (s) => states.push(s),
    onFailure: (f, n) => failures.push([f, n]),
    schedule: (fn, ms) => {
      const timer = { at: t + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    now: () => t,
  });

  return {
    fetchLive,
    attempts,
    states,
    values,
    failures,
    get clock() {
      return t;
    },
    advance: async (ms: number) => {
      t += ms;
      for (const timer of timers) {
        if (timer.live && timer.at <= t) {
          timer.live = false;
          timer.fn();
        }
      }
      await flush();
    },
    pendingTimers: () => timers.filter((x) => x.live).length,
    nextDelay: () => {
      const live = timers.filter((x) => x.live);
      return live.length ? live[0].at - t : null;
    },
    hold: (on: boolean) => {
      hold = on;
    },
    release: async () => {
      gates.splice(0).forEach((g) => g());
      await flush();
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const ok = (value: string): AttemptResult<string> => ({ ok: true, value });
const bad = (failure: WorkerFailure): AttemptResult<string> => ({
  ok: false,
  failure,
});

describe("retryDelayMs", () => {
  it("backs off about 2 s, 5 s, 15 s and then stops", () => {
    expect(LIVE_RETRY_DELAYS_MS).toEqual([2_000, 5_000, 15_000]);
    expect(retryDelayMs(server, 0)).toBe(2_000);
    expect(retryDelayMs(server, 1)).toBe(5_000);
    expect(retryDelayMs(server, 2)).toBe(15_000);
    expect(retryDelayMs(server, 3)).toBeNull();
    expect(retryDelayMs(timeout, 1)).toBe(5_000);
  });

  it("honours Retry-After on a 429, never sooner than the backoff, capped", () => {
    expect(retryDelayMs(limited(30), 0)).toBe(30_000);
    expect(retryDelayMs(limited(1), 0)).toBe(2_000);
    // No readable Retry-After: wait for most of the limiter's window.
    expect(retryDelayMs(limited(), 0)).toBe(LIVE_RATE_LIMITED_DEFAULT_MS);
    expect(retryDelayMs(limited(), 1)).toBe(LIVE_RATE_LIMITED_DEFAULT_MS);
    expect(retryDelayMs(limited(), 2)).toBe(LIVE_RATE_LIMITED_DEFAULT_MS);
    expect(retryDelayMs(limited(9_999), 0)).toBe(LIVE_RETRY_AFTER_CAP_MS);
    // `Retry-After: 0` is a readable answer: the normal backoff, not the default wait.
    expect(retryDelayMs(limited(0), 0)).toBe(2_000);
  });

  it("does not retry a refused request, and waits for the browser when offline", () => {
    expect(retryDelayMs(invalid, 0)).toBeNull();
    expect(retryDelayMs(offline, 0)).toBeNull();
  });
});

describe("createLiveFetch", () => {
  it("a first success delivers the value and ends the episode", async () => {
    const h = harness([ok("live")]);
    h.fetchLive.start();
    await flush();
    expect(h.values).toEqual(["live"]);
    expect(h.fetchLive.state().status).toBe("ok");
    expect(h.attempts).toEqual([{ attempt: 1, force: false }]);
    expect(h.pendingTimers()).toBe(0);
  });

  it("retries a failure after 2 s, 5 s and 15 s, then gives up after 4 attempts in all", async () => {
    const h = harness([bad(server)]);
    h.fetchLive.start();
    await flush();
    expect(h.fetchLive.state()).toMatchObject({
      status: "retrying",
      retryInMs: 2_000,
      failure: server,
    });

    await h.advance(1_999);
    expect(h.attempts).toHaveLength(1);
    await h.advance(1);
    expect(h.attempts).toHaveLength(2);
    expect(h.nextDelay()).toBe(5_000);

    await h.advance(5_000);
    expect(h.attempts).toHaveLength(3);
    expect(h.nextDelay()).toBe(15_000);

    await h.advance(15_000);
    expect(h.attempts).toHaveLength(4);
    expect(h.fetchLive.state().status).toBe("failed");
    expect(h.pendingTimers()).toBe(0);

    // Nothing more, however long we wait.
    await h.advance(10 * 60_000);
    expect(h.attempts).toHaveLength(4);
    // A retry bypasses the remembered failure; the first attempt does not need to.
    expect(h.attempts.map((a) => a.force)).toEqual([false, true, true, true]);
  });

  it("recovers: the first success after failures delivers the value and clears the failure", async () => {
    const h = harness([bad(timeout), bad(server), ok("live")]);
    h.fetchLive.start();
    await flush();
    await h.advance(2_000);
    await h.advance(5_000);
    expect(h.values).toEqual(["live"]);
    expect(h.fetchLive.state()).toMatchObject({
      status: "ok",
      failure: null,
      retryInMs: null,
    });
    expect(h.pendingTimers()).toBe(0);
  });

  it("a 429 waits for Retry-After", async () => {
    const h = harness([bad(limited(20)), ok("live")]);
    h.fetchLive.start();
    await flush();
    expect(h.nextDelay()).toBe(20_000);
    await h.advance(19_999);
    expect(h.attempts).toHaveLength(1);
    await h.advance(1);
    expect(h.values).toEqual(["live"]);
  });

  it("a refused request (4xx other than 429) is not retried", async () => {
    const h = harness([bad(invalid)]);
    h.fetchLive.start();
    await flush();
    expect(h.fetchLive.state().status).toBe("failed");
    expect(h.pendingTimers()).toBe(0);
    await h.advance(60_000);
    expect(h.attempts).toHaveLength(1);
  });

  it("offline sets no timer; the online event tries once", async () => {
    const h = harness([bad(offline), ok("live")]);
    h.fetchLive.start();
    await flush();
    expect(h.fetchLive.state()).toMatchObject({
      status: "failed",
      failure: offline,
    });
    expect(h.pendingTimers()).toBe(0);

    await h.advance(LIVE_EVENT_MIN_GAP_MS + 1);
    h.fetchLive.nudge("online");
    await flush();
    expect(h.attempts).toHaveLength(2);
    expect(h.values).toEqual(["live"]);
  });

  it("an event while an attempt is in flight is ignored (one in flight, no reload)", async () => {
    const h = harness([ok("live")]);
    h.hold(true);
    h.fetchLive.start();
    await flush();
    h.fetchLive.nudge("online");
    h.fetchLive.nudge("visible");
    h.fetchLive.retryNow();
    expect(h.attempts).toHaveLength(1);
    h.hold(false);
    await h.release();
    expect(h.values).toEqual(["live"]);
    expect(h.attempts).toHaveLength(1);
  });

  it("an event is ignored when nothing is wrong, and once an episode has succeeded", async () => {
    const h = harness([ok("live")]);
    h.fetchLive.nudge("visible"); // never started
    h.fetchLive.start();
    await flush();
    await h.advance(60_000);
    h.fetchLive.nudge("visible");
    h.fetchLive.nudge("online");
    await flush();
    expect(h.attempts).toHaveLength(1);
  });

  it("an event while a retry is waiting runs that attempt now, once, and replaces the timer", async () => {
    const h = harness([bad(server), ok("live")]);
    h.fetchLive.start();
    await flush();
    expect(h.nextDelay()).toBe(2_000);

    await h.advance(LIVE_EVENT_MIN_GAP_MS + 1);
    h.fetchLive.nudge("visible");
    await flush();
    expect(h.attempts).toHaveLength(2);
    expect(h.values).toEqual(["live"]);
    expect(h.pendingTimers()).toBe(0);
  });

  it("events arriving together make one attempt", async () => {
    const h = harness([bad(server), bad(server), bad(server)]);
    h.fetchLive.start();
    await flush();
    await h.advance(LIVE_EVENT_MIN_GAP_MS + 1);
    h.fetchLive.nudge("online");
    h.fetchLive.nudge("visible");
    h.fetchLive.nudge("online");
    await flush();
    expect(h.attempts).toHaveLength(2);
  });

  it("an event right after an attempt (inside the minimum gap) is ignored", async () => {
    const h = harness([bad(server), ok("live")]);
    h.fetchLive.start();
    await flush();
    h.fetchLive.nudge("online");
    await flush();
    expect(h.attempts).toHaveLength(1);
  });

  it("after the retries are used up, one event makes one more attempt and no more timers", async () => {
    const h = harness([bad(server)]);
    h.fetchLive.start();
    await flush();
    await h.advance(2_000);
    await h.advance(5_000);
    await h.advance(15_000);
    expect(h.attempts).toHaveLength(4);
    await h.advance(LIVE_EVENT_MIN_GAP_MS + 1);
    h.fetchLive.nudge("online");
    await flush();
    expect(h.attempts).toHaveLength(5);
    expect(h.fetchLive.state().status).toBe("failed");
    expect(h.pendingTimers()).toBe(0);
  });

  it("'Try again' runs now, starts a fresh episode and its failures retry again", async () => {
    const h = harness([bad(server)]);
    h.fetchLive.start();
    await flush();
    await h.advance(2_000);
    await h.advance(5_000);
    await h.advance(15_000);
    expect(h.fetchLive.state().status).toBe("failed");

    h.fetchLive.retryNow();
    await flush();
    expect(h.attempts).toHaveLength(5);
    expect(h.attempts.at(-1)).toEqual({ attempt: 1, force: true });
    expect(h.nextDelay()).toBe(2_000);
  });

  it("stop cancels the timer and ignores a late answer", async () => {
    const h = harness([bad(server), ok("late")]);
    h.fetchLive.start();
    await flush();
    h.fetchLive.stop();
    expect(h.pendingTimers()).toBe(0);
    await h.advance(60_000);
    expect(h.attempts).toHaveLength(1);

    const g = harness([ok("late")]);
    g.hold(true);
    g.fetchLive.start();
    await flush();
    g.fetchLive.stop();
    await g.release();
    expect(g.values).toEqual([]);
  });

  it("logs every failure with its attempt number, and an attempt that throws is a server failure", async () => {
    const warn = vi.fn();
    let n = 0;
    const timers: Array<() => void> = [];
    const fl = createLiveFetch<string>({
      attempt: async () => {
        n++;
        if (n === 1) throw new Error("boom");
        return { ok: false, failure: timeout };
      },
      onValue: () => undefined,
      onFailure: (f, attempt) => warn(f.kind, attempt),
      schedule: (fn) => {
        timers.push(fn);
        return () => undefined;
      },
    });
    fl.start();
    await flush();
    timers.shift()?.();
    await flush();
    expect(warn.mock.calls).toEqual([
      ["server", 1],
      ["timeout", 2],
    ]);
  });

  it("a page that already has live weather retries once, not three times", async () => {
    let t = 1_000_000;
    const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
    const attempts: number[] = [];
    const fl = createLiveFetch<string>({
      maxRetries: 1,
      attempt: async ({ attempt }) => {
        attempts.push(attempt);
        return { ok: false, failure: server };
      },
      onValue: () => undefined,
      schedule: (fn, ms) => {
        const timer = { at: t + ms, fn, live: true };
        timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
      now: () => t,
    });
    fl.start();
    await flush();
    t += 2_000;
    timers.forEach((x) => x.live && x.at <= t && ((x.live = false), x.fn()));
    await flush();
    t += 60_000;
    timers.forEach((x) => x.live && x.at <= t && ((x.live = false), x.fn()));
    await flush();
    expect(attempts).toEqual([1, 2]);
    expect(fl.state().status).toBe("failed");
  });
});
