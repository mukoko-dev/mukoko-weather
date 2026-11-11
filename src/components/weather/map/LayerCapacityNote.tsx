"use client";

import { busySubject, capacityNoteText } from "@/lib/map-capacity";

/**
 * Shown in the map sheet when the layer the person chose is a Tomorrow.io one
 * that has no live tiles right now (the provider's small free quota is spent),
 * so the map is showing another layer instead. It says what happened in plain
 * words and offers one tap to look again; it blames no one and shows no code.
 * A status line, mounted when the swap happens so it is read out once, never
 * an alert: nothing is broken, a working layer is on screen.
 *
 * `fallbackLabel` is the chip name of the layer shown instead ("Satellite").
 * "Try again" is a Mzizi pill control (49 px minimum) and shows "Checking…"
 * while its one tile request is out.
 */
export function LayerCapacityNote({
  layerId,
  fallbackLabel,
  rechecking,
  onRetry,
}: {
  /** The layer the person chose, which is not on screen. */
  layerId: string;
  fallbackLabel: string;
  rechecking: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      data-slot="layer-capacity-note"
      className="mt-2 flex items-center gap-[var(--gap-floor)]"
    >
      <p role="status" className="min-w-0 flex-1 text-sm text-text-primary">
        {capacityNoteText(layerId, fallbackLabel)}
      </p>
      <button
        type="button"
        onClick={onRetry}
        disabled={rechecking}
        aria-busy={rechecking}
        // The visible words stay whole inside the name (label in name).
        aria-label={
          rechecking
            ? undefined
            : `Try again: ${busySubject(layerId).toLowerCase()}`
        }
        className="impala-sm shrink-0"
      >
        {rechecking ? "Checking…" : "Try again"}
      </button>
    </div>
  );
}
