"use client";

import { Spinner } from "@/components/ui/spinner";

/**
 * Shown when the visitor's own request for a place's weather is not getting
 * through. It floats above the mobile nav (like `LocationPromptCard`), so it
 * never moves the page or the skeleton under it, and the retry is a new
 * request, not a page reload. Two states, one card:
 *
 * - `slow`: the forecast has taken longer than a healthy request does, the
 *   retries are still running and nothing is stored to show meanwhile. A calm
 *   `status` line (read out politely, not an alert) plus "Try again".
 * - otherwise: the retries are spent. "Couldn't load ..." as an `alert`.
 */
export function PlaceLoadNotice({
  placeName,
  showingSaved,
  busy,
  onRetry,
  slow = false,
}: {
  placeName: string;
  /** A stored copy is on screen, so the weather shown is not live. */
  showingSaved: boolean;
  busy: boolean;
  onRetry: () => void;
  /** The retries are still running; see above. */
  slow?: boolean;
}) {
  return (
    <section
      role={slow ? "status" : "alert"}
      aria-live={slow ? "polite" : undefined}
      aria-label={
        slow
          ? "Weather is taking longer than usual"
          : "Weather could not be loaded"
      }
      className="fixed inset-x-3 bottom-[var(--mobile-nav-clearance)] z-30 mx-auto max-w-md animate-fade-in-up rounded-[var(--radius-card)] border border-primary/25 bg-surface-card/95 p-3 shadow-lg backdrop-blur-xl sm:bottom-6"
    >
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-text-primary">
          {slow
            ? "Still trying to reach the weather service…"
            : showingSaved
              ? `Couldn't refresh the weather for ${placeName}. Showing what is saved on this device.`
              : `Couldn't load the weather for ${placeName}.`}
        </p>
        <button
          type="button"
          onClick={onRetry}
          disabled={busy}
          aria-busy={busy}
          className="kudu-sm shrink-0"
        >
          {busy && <Spinner className="h-4 w-4" />}
          {busy ? "Trying…" : "Try again"}
        </button>
      </div>
    </section>
  );
}
