"use client";

import { Spinner } from "@/components/ui/spinner";
import { FLOATING_CARD_CLASS } from "@/components/ui/floating-stack";

/**
 * Shown when the visitor's own request for a place's weather is not getting
 * through. It floats above the mobile nav (like `LocationPromptCard`, in the
 * same `FloatingStack`, so the two stack rather than overlap), so it never
 * moves the page or the skeleton under it, and the retry is a new request, not
 * a page reload. Two states, one card:
 *
 * - `slow`: the forecast has taken longer than a healthy request does, the
 *   retries are still running and nothing is stored to show meanwhile. A calm
 *   `status` line (read out politely, not an alert) plus "Try again", which
 *   shows "Trying…" (`busy`) while the attempt it started is in flight.
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
      className={FLOATING_CARD_CLASS}
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
