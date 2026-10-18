"use client";

import { useEffect, useState } from "react";

/**
 * True once the browser has had its first idle moment after mount
 * (requestIdleCallback), or after `timeoutMs` at the latest, and from then
 * on. Browsers without requestIdleCallback (Safari) use the timeout.
 */
export function useIdleOnce(timeoutMs = 2500): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (idle) return;
    const w = window as Window & {
      requestIdleCallback?: (
        cb: () => void,
        opts?: { timeout: number },
      ) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof w.requestIdleCallback === "function") {
      const id = w.requestIdleCallback(() => setIdle(true), {
        timeout: timeoutMs,
      });
      return () => w.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(() => setIdle(true), timeoutMs);
    return () => window.clearTimeout(id);
  }, [idle, timeoutMs]);
  return idle;
}
