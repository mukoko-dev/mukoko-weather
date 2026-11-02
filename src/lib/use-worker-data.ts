"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { WorkerRoute } from "./weather-api";
import {
  workerData,
  workerDataKey,
  type WorkerDataOptions,
  type WorkerQuery,
} from "./worker-data";

/** What a section renders from: loading, the data, or "unavailable". */
export type WorkerDataState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error" };

export type UseWorkerDataOptions = Pick<
  WorkerDataOptions,
  "exact" | "ttlMs" | "retries"
>;

const LOADING = { status: "loading" } as const;

/**
 * Read a Worker route for a section, through the shared store
 * (`worker-data.ts`): the same route + 0.05 degree cell is fetched once for
 * every component that asks, a remount (LazySection scrolling a section away
 * and back, a swipe back to a place already shown) is answered from memory,
 * and leaving the page only stops this component waiting.
 *
 * The state is read FROM the store (`useSyncExternalStore`), not copied into
 * component state, so it is always what the store holds: the server render
 * and the hydration render are `loading` (the server snapshot) whatever the
 * browser's store holds, and a kept answer is the first state after that, with
 * no skeleton flash for data already in hand.
 *
 * - `enabled` false: nothing is fetched and the state stays `loading` (a
 *   section holds its fetch until it is near the viewport).
 * - An expired answer is shown while it is read again (stale while
 *   revalidate).
 */
export function useWorkerData<T>(
  route: WorkerRoute,
  query: WorkerQuery,
  enabled = true,
  options: UseWorkerDataOptions = {},
): WorkerDataState<T> {
  const { exact, ttlMs, retries } = options;
  const { key, search } = workerDataKey(route, query, exact);

  const settled = useSyncExternalStore(
    workerData.subscribe,
    () => workerData.peekSettled<T>(route, query, { exact }),
    () => undefined,
  );

  useEffect(() => {
    if (!enabled) return;
    // The key and the request come from the same string, so what is asked for
    // is exactly what is stored. The result is read back through the store
    // (this component is told when it settles); a failure is typed in the
    // store, not thrown here.
    const params = Object.fromEntries(new URLSearchParams(search));
    void workerData.read(route, params, { exact, ttlMs, retries });
  }, [route, key, search, enabled, exact, ttlMs, retries]);

  if (!enabled || !settled) return LOADING;
  return settled.ok && settled.data !== null
    ? { status: "ready", data: settled.data }
    : { status: "error" };
}
