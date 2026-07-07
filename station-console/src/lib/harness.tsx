"use client";

import * as React from "react";

/**
 * Minimal local implementation of the Nyuchi infrastructure harness — the
 * observability/motion/a11y hook that every L3+ brand component destructures
 * (`const { log, motion, LiveRegion } = useNyuchiHarness(scope)`).
 *
 * The published `@nyuchi` harness package is not yet on the registry; this
 * shim keeps the vendored shell components source-compatible so they can be
 * swapped to the real harness without edits when it ships.
 */

export interface HarnessMotion {
  prefersReduced: boolean;
  enterDuration: number;
  enterEasing: string;
}

export interface NyuchiHarness {
  log: (event: string, data?: Record<string, unknown>) => void;
  motion: HarnessMotion;
  LiveRegion: React.ReactNode;
}

export function useNyuchiHarness(scope: string): NyuchiHarness {
  const [prefersReduced, setPrefersReduced] = React.useState(false);

  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setPrefersReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const log = React.useCallback(
    (event: string, data?: Record<string, unknown>) => {
      if (process.env.NODE_ENV !== "production") {
        console.debug(`[nyuchi:${scope}]`, event, data ?? {});
      }
    },
    [scope],
  );

  const motion = React.useMemo<HarnessMotion>(
    () => ({
      prefersReduced,
      enterDuration: 400,
      enterEasing: "cubic-bezier(0.22, 1, 0.36, 1)",
    }),
    [prefersReduced],
  );

  const LiveRegion = React.useMemo(
    () => (
      <div aria-live="polite" className="sr-only" data-slot="live-region" />
    ),
    [],
  );

  return { log, motion, LiveRegion };
}
