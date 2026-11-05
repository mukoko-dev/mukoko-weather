"use client";

import { useEffect, useRef, useState } from "react";
import { DISPLAY_REFRESH_MS, emptyRetryDelayMs } from "@/lib/display";

/**
 * Keeps an unattended display's screen on. Uses the Screen Wake Lock API
 * where the browser has it (Chrome/Edge on TVs, Android tablets, Safari 16.4+)
 * and re-acquires it whenever the page becomes visible again, because the
 * browser drops the lock on every tab switch or screen-off. A no-op elsewhere.
 */
export function useWakeLock(): void {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (cancelled) {
          void next.release();
          return;
        }
        sentinel = next;
      } catch {
        // Denied (battery saver, no user gesture yet) — the screen may sleep.
      }
    };

    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", acquire);
      void sentinel?.release();
    };
  }, []);
}

/** Reloads the page every few hours so a long-running screen picks up deploys. */
export function usePeriodicReload(
  ms: number = DISPLAY_REFRESH_MS.reload,
): void {
  useEffect(() => {
    const id = window.setTimeout(() => window.location.reload(), ms);
    return () => window.clearTimeout(id);
  }, [ms]);
}

export type PolledState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T; updatedAt: number }
  | { status: "error"; data?: T; updatedAt?: number };

/**
 * Fetches `url` now and every `intervalMs`, keeping the last good value on a
 * failed refresh (a wall display should show slightly old data rather than a
 * blank panel). `initial` seeds the first render, e.g. from a stored copy.
 *
 * Until there is data, a failed read is not left for the next interval (10
 * minutes or more of an empty panel): it is read again after about 2 s, 5 s,
 * 15 s, 30 s and then every minute (`emptyRetryDelayMs`), so a screen whose
 * first read was refused or dropped fills in as soon as the service is back.
 */
export function usePolledJson<T>(
  url: string | null,
  intervalMs: number,
  validate: (json: unknown) => json is T,
  initial?: T,
): PolledState<T> {
  const [state, setState] = useState<PolledState<T>>(() =>
    initial !== undefined
      ? { status: "ready", data: initial, updatedAt: Date.now() }
      : { status: "loading" },
  );
  const validateRef = useRef(validate);
  // Kept current after each commit, not during render. Declared before the
  // polling effect below (passive effects run in order), and only read from
  // that effect's async callbacks.
  useEffect(() => {
    validateRef.current = validate;
  });
  const skipFirst = useRef(initial !== undefined);
  const seeded = useRef(initial !== undefined);

  useEffect(() => {
    if (!url) return;
    let controller: AbortController | null = null;
    let retryTimer: number | undefined;
    let hasData = seeded.current;
    let failures = 0;

    const load = async () => {
      window.clearTimeout(retryTimer);
      controller?.abort();
      const current = new AbortController();
      controller = current;
      // A manual timeout rather than AbortSignal.any/timeout: older TV and
      // tablet browsers lack those, and this page must run on them.
      let timedOut = false;
      const timer = window.setTimeout(() => {
        timedOut = true;
        current.abort();
      }, 15_000);
      try {
        const res = await fetch(url, { signal: current.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: unknown = await res.json();
        if (!validateRef.current(json)) throw new Error("bad shape");
        hasData = true;
        failures = 0;
        setState({ status: "ready", data: json, updatedAt: Date.now() });
      } catch (err) {
        // Superseded or unmounted: not a failure. A timeout is.
        if (
          !timedOut &&
          (err as { name?: string } | null)?.name === "AbortError"
        )
          return;
        setState((prev) =>
          prev.status === "ready"
            ? { status: "error", data: prev.data, updatedAt: prev.updatedAt }
            : prev.status === "error"
              ? prev
              : { status: "error" },
        );
        // Nothing to show yet: ask again soon, not at the next interval.
        if (!hasData) {
          retryTimer = window.setTimeout(load, emptyRetryDelayMs(failures));
          failures += 1;
        }
      } finally {
        window.clearTimeout(timer);
      }
    };

    // Server-seeded data is fresh at mount; wait one interval before refetching.
    if (skipFirst.current) skipFirst.current = false;
    else void load();
    const id = window.setInterval(load, intervalMs);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(retryTimer);
      controller?.abort();
    };
  }, [url, intervalMs]);

  return state;
}
