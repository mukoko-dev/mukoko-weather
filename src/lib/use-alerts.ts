"use client";

import { useEffect, useState } from "react";
import type { AlertSnapshot } from "./alerts-watch";
import { useIdleOnce } from "./use-idle-once";

/**
 * The alerts for the person's places, kept current by `watchAlerts`
 * (event-driven, never a timer or a request). The watch and everything it
 * pulls in (the rules, the device store, the report store) is loaded on
 * demand, so none of it is in a page's first-load JavaScript.
 *
 * `enabled` false: nothing is loaded and the snapshot is null.
 */
export function useAlertSnapshot(enabled: boolean): AlertSnapshot | null {
  const [snapshot, setSnapshot] = useState<AlertSnapshot | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let stop: (() => void) | null = null;
    void import("./alerts-watch")
      .then((m) => {
        if (cancelled) return;
        stop = m.watchAlerts((next) => {
          if (!cancelled) setSnapshot(next);
        });
      })
      .catch(() => {
        // The chunk could not load (offline): the bell simply shows no dot.
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [enabled]);

  return enabled ? snapshot : null;
}

/**
 * How many alerts the bell announces. It waits for the browser's first idle
 * moment (the page paints first), and is zero while the person is in their
 * quiet hours or has switched every kind off; the list still shows the alerts of
 * the kinds that are on.
 */
export function useAlertBadge(): number {
  const idle = useIdleOnce(2500);
  const snapshot = useAlertSnapshot(idle);
  if (!snapshot || snapshot.quiet) return 0;
  return snapshot.shown.length;
}
