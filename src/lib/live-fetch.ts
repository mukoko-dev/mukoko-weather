/**
 * Getting live weather onto a page that was served without it, and keeping at
 * it (#414).
 *
 * The server render can answer with the seasonal estimate when no provider
 * answers in time. The page then has to fetch the live forecast itself. It used
 * to try once, swallow every error and stay on the "Live weather data
 * temporarily unavailable" banner for good, even after the API had recovered.
 *
 * The rules:
 *
 * - A failed attempt is retried after about 2 s, 5 s and 15 s (three retries
 *   after the first attempt), then it stops and says so.
 * - A 429 waits for `Retry-After` (never less than the backoff, at most 60 s;
 *   30 s when the browser cannot read the header).
 *   Timeouts and 5xx back off the same way. A refused request (a 4xx other
 *   than 429) is not retried. Offline is not retried on a timer either: the
 *   browser's `online` event does it.
 * - The `online` event and the page becoming visible again each make ONE
 *   attempt when the last one failed (`nudge`), never while one is in flight
 *   and never twice within a second. Nothing reloads the page.
 * - "Try again" (`retryNow`) starts a fresh episode right away.
 * - Every failure is reported (`onFailure`); every success clears the failure
 *   state at once.
 *
 * Framework free: the attempt, the timer and the clock are injected, so every
 * rule is tested with a manual scheduler.
 */

import type { WorkerFailure } from "./worker-data";

/** Waits before retry 1, 2 and 3. */
export const LIVE_RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;
/** The longest a `Retry-After` is honoured. */
export const LIVE_RETRY_AFTER_CAP_MS = 60_000;
/**
 * A 429 whose `Retry-After` the browser could not read (or that has none)
 * waits this long: the limiter's window is a minute, so retrying in 2 s would
 * only spend the next window's budget.
 */
export const LIVE_RATE_LIMITED_DEFAULT_MS = 30_000;
/** Events closer than this to the last attempt are ignored. */
export const LIVE_EVENT_MIN_GAP_MS = 1_000;

/**
 * The wait before the next automatic retry, or null for none. `retryNumber`
 * counts retries already made (0 for the first retry).
 */
export function retryDelayMs(
  failure: WorkerFailure,
  retryNumber: number,
  maxRetries: number = LIVE_RETRY_DELAYS_MS.length,
): number | null {
  if (retryNumber >= maxRetries) return null;
  // A refused request cannot get better; offline waits for the `online` event.
  if (failure.kind === "invalid" || failure.kind === "offline") return null;
  const base = LIVE_RETRY_DELAYS_MS[retryNumber];
  if (base === undefined) return null;
  if (failure.kind === "rate_limited") {
    // `Retry-After: 0` (or a date already past) is an answer: retry on the
    // normal backoff. Only a missing header gets the default wait.
    const asked =
      failure.retryAfterSeconds !== undefined
        ? Math.min(failure.retryAfterSeconds * 1000, LIVE_RETRY_AFTER_CAP_MS)
        : LIVE_RATE_LIMITED_DEFAULT_MS;
    return Math.max(base, asked);
  }
  return base;
}

export type AttemptResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: WorkerFailure };

export type LiveFetchStatus = "idle" | "loading" | "ok" | "retrying" | "failed";

export interface LiveFetchState {
  status: LiveFetchStatus;
  /** The last failure; null after a success. */
  failure: WorkerFailure | null;
  /** Attempts made in this episode. */
  attempt: number;
  /** While `retrying`: the wait before the next attempt. */
  retryInMs: number | null;
}

export interface LiveFetchOptions<T> {
  /** One attempt. `force` is true for every attempt after the first. */
  attempt: (info: {
    attempt: number;
    force: boolean;
  }) => Promise<AttemptResult<T>>;
  onValue: (value: T) => void;
  onState?: (state: LiveFetchState) => void;
  onFailure?: (failure: WorkerFailure, attempt: number) => void;
  /** Run `fn` after `ms`; returns the canceller. Default: setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
  now?: () => number;
  /**
   * Retries after the first attempt (default 3: 2 s, 5 s, 15 s). A page that
   * already has live weather asks for 1: its fetch only feeds optional cards.
   */
  maxRetries?: number;
}

export interface LiveFetch {
  /** Begin an episode (the first attempt). */
  start(): void;
  /** The visitor pressed "Try again": a fresh episode, now. */
  retryNow(): void;
  /** The browser came online / the page became visible. */
  nudge(reason: "online" | "visible"): void;
  /** Leave: cancel the timer and ignore a late answer. */
  stop(): void;
  state(): LiveFetchState;
}

const defaultSchedule = (fn: () => void, ms: number) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export function createLiveFetch<T>(options: LiveFetchOptions<T>): LiveFetch {
  const schedule = options.schedule ?? defaultSchedule;
  const now = options.now ?? Date.now;
  const maxRetries = options.maxRetries ?? LIVE_RETRY_DELAYS_MS.length;

  let state: LiveFetchState = {
    status: "idle",
    failure: null,
    attempt: 0,
    retryInMs: null,
  };
  let inFlight = false;
  let stopped = false;
  let epoch = 0;
  let lastStartedAt = -Infinity;
  let cancelTimer: (() => void) | null = null;

  function set(next: Partial<LiveFetchState>): void {
    state = { ...state, ...next };
    options.onState?.(state);
  }

  function clearTimer(): void {
    cancelTimer?.();
    cancelTimer = null;
  }

  async function run(force: boolean): Promise<void> {
    if (stopped || inFlight) return;
    clearTimer();
    inFlight = true;
    const myEpoch = epoch;
    const attempt = state.attempt + 1;
    lastStartedAt = now();
    set({ status: "loading", attempt, retryInMs: null });

    let result: AttemptResult<T>;
    try {
      result = await options.attempt({ attempt, force });
    } catch {
      result = { ok: false, failure: { kind: "server", status: 0 } };
    }
    if (stopped || myEpoch !== epoch) return;
    inFlight = false;

    if (result.ok) {
      set({ status: "ok", failure: null, retryInMs: null });
      options.onValue(result.value);
      return;
    }

    options.onFailure?.(result.failure, attempt);
    const delay = retryDelayMs(result.failure, attempt - 1, maxRetries);
    if (delay === null) {
      set({ status: "failed", failure: result.failure, retryInMs: null });
      return;
    }
    set({ status: "retrying", failure: result.failure, retryInMs: delay });
    cancelTimer = schedule(() => {
      cancelTimer = null;
      void run(true);
    }, delay);
  }

  return {
    start() {
      if (stopped || inFlight) return;
      set({ attempt: 0, failure: null, retryInMs: null });
      void run(false);
    },
    retryNow() {
      if (stopped || inFlight) return;
      clearTimer();
      set({ attempt: 0 });
      void run(true);
    },
    nudge() {
      if (stopped || inFlight) return;
      // Only a failed or waiting episode has anything to retry.
      if (state.status !== "failed" && state.status !== "retrying") return;
      if (now() - lastStartedAt < LIVE_EVENT_MIN_GAP_MS) return;
      void run(true);
    },
    stop() {
      stopped = true;
      epoch += 1;
      clearTimer();
    },
    state: () => state,
  };
}
