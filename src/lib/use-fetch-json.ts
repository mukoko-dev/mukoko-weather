"use client";

import { useEffect, useState } from "react";
import { fetchJsonOrThrow } from "./fetch-json";

export interface UseFetchJsonResult<T> {
  /** Parsed body for the current url/deps, or null while loading or on error. */
  data: T | null;
  /** The failure for the current url/deps, or null. */
  error: Error | null;
  /** True while the request for the current url/deps is in flight. */
  loading: boolean;
}

interface SettledState<T> {
  key: string;
  data: T | null;
  error: Error | null;
}

/**
 * Fetch JSON from `url` on mount and whenever `url` or `deps` change.
 *
 * Pass `null` as the url to skip fetching (result is idle: no data, no error,
 * not loading). Each request is aborted when its inputs change or the
 * component unmounts, so a stale response never overwrites a newer one.
 *
 * `deps` should hold the primitive values the URL is built from; they are
 * folded into the request key alongside `url`.
 */
export function useFetchJson<T>(
  url: string | null,
  deps: readonly unknown[] = [],
): UseFetchJsonResult<T> {
  const key = url === null ? null : [url, ...deps].map(String).join("\u0000");
  const [settled, setSettled] = useState<SettledState<T> | null>(null);

  useEffect(() => {
    if (key === null || url === null) return;
    const controller = new AbortController();
    let active = true;

    fetchJsonOrThrow<T>(url, { signal: controller.signal }).then(
      (data) => {
        if (active) setSettled({ key, data, error: null });
      },
      (err: unknown) => {
        if (!active) return;
        setSettled({
          key,
          data: null,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      },
    );

    return () => {
      active = false;
      controller.abort();
    };
  }, [key, url]);

  // Results only count for the inputs they were requested with, so a previous
  // key's data is never shown for the current one.
  const current = key !== null && settled?.key === key ? settled : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: key !== null && current === null,
  };
}
