"use client";

import { busySubject, capacityNoteText } from "@/lib/map-capacity";

/** What the retry button is doing; sets its words and whether it takes a tap. */
export type RetryStatus = "idle" | "checking" | "recent";

const RETRY_WORDS: Record<RetryStatus, string> = {
  idle: "Try again",
  checking: "Checking…",
  // A real request is not allowed yet, so the tap was answered from memory.
  recent: "Checked a moment ago",
};

/**
 * Shown in the map sheet when the layer the person chose is a Tomorrow.io one
 * that has no live tiles right now (the provider's small free quota is spent),
 * so the map is showing another layer instead. It says what happened in plain
 * words and offers one tap to look again; it blames no one and shows no code.
 *
 * The words are announced by the page's live region (see useLayerCapacity),
 * which stays mounted; this node is plain content, so it is not read twice.
 *
 * "Try again" is a Mzizi pill control (49 px minimum). While it is checking, or
 * has just checked, it is `aria-disabled`, not `disabled`: a disabled button
 * drops keyboard focus, and the person would lose their place. The tap is
 * ignored instead. It shows "Checking…" only while its one request is out, and
 * "Checked a moment ago" when the answer came from memory: it never claims to be
 * looking when it is not.
 *
 * `fallbackLabel` is the chip name of the layer shown instead ("Satellite").
 */
export function LayerCapacityNote({
  layerId,
  fallbackLabel,
  status,
  onRetry,
}: {
  /** The layer the person chose, which is not on screen. */
  layerId: string;
  fallbackLabel: string;
  status: RetryStatus;
  onRetry: () => void;
}) {
  const idle = status === "idle";
  return (
    <div
      data-slot="layer-capacity-note"
      className="mt-2 flex flex-wrap items-center justify-between gap-[var(--gap-floor)]"
    >
      <p className="min-w-0 flex-1 basis-48 text-sm text-text-primary">
        {capacityNoteText(layerId, fallbackLabel)}
      </p>
      <button
        type="button"
        onClick={() => {
          if (idle) onRetry();
        }}
        aria-disabled={idle ? undefined : true}
        aria-busy={status === "checking" ? true : undefined}
        // The visible words stay whole inside the name (label in name).
        aria-label={
          idle ? `Try again: ${busySubject(layerId).toLowerCase()}` : undefined
        }
        className="impala-sm shrink-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
      >
        {RETRY_WORDS[status]}
      </button>
    </div>
  );
}

/**
 * The line shown while the one tile that decides is on its way and the overlay
 * is held back, so the map is not silently empty under a legend.
 */
export function LayerCheckingLine({ layerId }: { layerId: string }) {
  return (
    <p
      data-slot="layer-checking-line"
      className="mt-2 text-sm text-text-secondary"
    >
      {`Checking ${busySubject(layerId).toLowerCase()}…`}
    </p>
  );
}

/**
 * Everything the sheet header says about the live layers' capacity, in one
 * place: the note (with its retry) while the fallback is shown, the checking
 * line while the overlay is held and a request is out, nothing otherwise.
 */
export function LayerCapacityStatus({
  layerId,
  fallbackLabel,
  state,
  recent,
  onRetry,
}: {
  layerId: string;
  fallbackLabel: string;
  state: { busy: boolean; held: boolean; checking: boolean };
  recent: boolean;
  onRetry: () => void;
}) {
  if (state.busy) {
    const status: RetryStatus = state.checking
      ? "checking"
      : recent
        ? "recent"
        : "idle";
    return (
      <LayerCapacityNote
        layerId={layerId}
        fallbackLabel={fallbackLabel}
        status={status}
        onRetry={onRetry}
      />
    );
  }
  if (state.held && state.checking)
    return <LayerCheckingLine layerId={layerId} />;
  return null;
}
