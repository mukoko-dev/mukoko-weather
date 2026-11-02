"use client";

import { useEffect, useState } from "react";

/**
 * True once the browser has had its first idle moment after mount
 * (requestIdleCallback), or after `timeoutMs` at the latest, and from then
 * on. Browsers without requestIdleCallback (Safari) use the timeout.
 *
 * `resetKey` starts the wait over when it changes: a component that stays
 * mounted while its content changes (the dashboard moving to another place)
 * defers that content's work the same way a fresh mount would.
 */
export function useIdleOnce(timeoutMs = 2500, resetKey?: string): boolean {
  const [idleFor, setIdleFor] = useState<string | undefined | null>(null);
  const idle = idleFor !== null && idleFor === resetKey;
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
      const id = w.requestIdleCallback(() => setIdleFor(resetKey), {
        timeout: timeoutMs,
      });
      return () => w.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(() => setIdleFor(resetKey), timeoutMs);
    return () => window.clearTimeout(id);
  }, [idle, timeoutMs, resetKey]);
  return idle;
}
