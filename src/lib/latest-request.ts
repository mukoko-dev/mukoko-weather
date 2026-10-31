/**
 * "Only the latest request may set the page." A screen that fetches again when
 * the visitor changes a place or a range must ignore a slower, older answer
 * (a wide range for the place picked a moment ago) instead of letting it
 * overwrite the newer one. `begin()` aborts the request in flight and hands
 * back a signal for the new one plus a check to run after every `await`.
 *
 * Pure (no React, no timers), so the rule is tested without a component.
 */

export interface LatestRequest {
  /** Pass to `fetch`: it aborts when a newer request begins or on `cancel()`. */
  signal: AbortSignal;
  /** True only while no newer request has begun and nothing was cancelled. */
  isLatest(): boolean;
}

export interface LatestRequests {
  /** Start a request: the one in flight is aborted and stops being the latest. */
  begin(): LatestRequest;
  /** Abandon whatever is in flight (leaving the page): nothing is latest. */
  cancel(): void;
}

export function createLatestRequests(): LatestRequests {
  let seq = 0;
  let current: AbortController | null = null;
  return {
    begin() {
      current?.abort();
      const own = new AbortController();
      current = own;
      const id = ++seq;
      return { signal: own.signal, isLatest: () => id === seq };
    },
    cancel() {
      current?.abort();
      current = null;
      seq++;
    },
  };
}
