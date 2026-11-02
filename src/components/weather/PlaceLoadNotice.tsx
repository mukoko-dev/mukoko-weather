"use client";

import { Spinner } from "@/components/ui/spinner";

/**
 * Shown when the visitor's own request for a place's weather failed. It floats
 * above the mobile nav (like `LocationPromptCard`), so it never moves the
 * page, and the retry is a new request, not a page reload.
 */
export function PlaceLoadNotice({
  placeName,
  showingSaved,
  busy,
  onRetry,
}: {
  placeName: string;
  /** A stored copy is on screen, so the weather shown is not live. */
  showingSaved: boolean;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <section
      role="alert"
      aria-label="Weather could not be loaded"
      className="fixed inset-x-3 bottom-[var(--mobile-nav-clearance)] z-30 mx-auto max-w-md animate-fade-in-up rounded-[var(--radius-card)] border border-primary/25 bg-surface-card/95 p-3 shadow-lg backdrop-blur-xl sm:bottom-6"
    >
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-text-primary">
          {showingSaved
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
