"use client";

import { useEffect, useState } from "react";
import { useHydrated } from "@/lib/use-hydrated";

/**
 * Formats a Date as the human clock label, e.g. "Friday, 3 July 2026 at 08:33".
 * Exported for testing — the output is deterministic for a given Date + runtime
 * timezone. Kept pure (no `new Date()` inside) so both the caller and tests
 * control the instant.
 */
export function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Displays the user's current browser date and time, updated every minute. */
export function LiveClock() {
  // The clock reflects the *client's* wall clock, which differs from the
  // server's at SSR time — rendering it during hydration would cause a text
  // mismatch (React hydration error 418). Gate on `useHydrated()`: the server and the
  // first client render both return `null` (identical HTML → no mismatch), then
  // the real time is revealed after hydration. `label` is seeded from the
  // client clock and refreshed every minute by the interval below.
  const hydrated = useHydrated();
  const [label, setLabel] = useState<string>(() => formatDateTime(new Date()));

  useEffect(() => {
    const id = setInterval(() => setLabel(formatDateTime(new Date())), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!hydrated) return null;

  return (
    <p className="text-sm text-text-tertiary" aria-label={`Current time: ${label}`}>
      {label}
    </p>
  );
}
