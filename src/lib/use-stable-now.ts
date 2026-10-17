"use client";

import { useEffect, useMemo, useState } from "react";
import { instantMs } from "@/lib/location-time";

/**
 * The instant to treat as "now" on the FIRST render of a server-rendered
 * component: the forecast payload's own `current.time`, which the server
 * and the browser both have, so the HTML the server sent and the first
 * client render agree (no React hydration mismatch, error #418).
 *
 * Falls back to 0 (the epoch) when the payload has no usable time; callers
 * only use the value to pick hours out of the payload, and the real clock
 * replaces it straight after mount.
 */
export function seedNowMs(
  currentTime: string | null | undefined,
  offsetSeconds: number | null | undefined,
): number {
  const ms = instantMs(currentTime, offsetSeconds ?? 0);
  return ms ?? 0;
}

/**
 * "Now" for render code that reads the clock (insight sentences, the moon,
 * the next-24 h rain series).
 *
 * Calling `new Date()` during render gives the server and the browser two
 * different instants, so any text or attribute derived from it can differ
 * between the HTML and the first client render, which makes React throw
 * away the server HTML. This hook renders the payload time first, then
 * switches to the real clock after mount and keeps it fresh every
 * `refreshMs` (default one minute).
 */
export function useStableNow(seedMs: number, refreshMs = 60_000): Date {
  const [now, setNow] = useState<number>(seedMs);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setNow(Date.now()));
    const id = window.setInterval(() => setNow(Date.now()), refreshMs);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(id);
    };
  }, [refreshMs]);
  return useMemo(() => new Date(now), [now]);
}
