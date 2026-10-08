"use client";

import { X } from "lucide-react";
import { NavigationIcon } from "@/lib/weather-icons";
import { Spinner } from "@/components/ui/spinner";

/**
 * The ONE location ask on the home page.
 *
 * The page already shows weather for the server's best guess (last visited
 * place or IP location), so nothing blocks on this: it floats above the
 * mobile nav as a slim, dismissible card instead of a full-screen loader or a
 * banner that pushes the temperature below the fold. The browser's permission
 * prompt only appears after the visitor taps the button — never on page load —
 * so they know why it's being asked.
 */
export function LocationPromptCard({
  placeName,
  busy,
  message,
  onUseLocation,
  onDismiss,
  onSearch,
}: {
  /** The place currently on screen, e.g. "Harare". */
  placeName: string;
  /** GPS / lookup in flight. */
  busy: boolean;
  /** Error or denial copy from the last attempt, if any. */
  message: string | null;
  onUseLocation: () => void;
  onDismiss: () => void;
  /** Opens location search — the way forward when GPS is blocked. */
  onSearch: () => void;
}) {
  return (
    <section
      aria-label="Use your location"
      className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom,0px)+5.25rem)] z-30 mx-auto max-w-md animate-fade-in-up rounded-[var(--radius-card)] border border-primary/25 bg-surface-card/95 p-3 shadow-lg backdrop-blur-xl sm:bottom-6"
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-text-primary">
            Showing weather for <strong>{placeName}</strong>
          </p>
          {message && (
            <p className="mt-0.5 text-sm text-severity-moderate" role="alert">
              {message}
            </p>
          )}
        </div>
        {message ? (
          <button type="button" onClick={onSearch} className="kudu-sm shrink-0">
            Search
          </button>
        ) : (
          <button
            type="button"
            onClick={onUseLocation}
            disabled={busy}
            aria-busy={busy}
            className="kudu-sm shrink-0"
          >
            {busy ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <NavigationIcon size={14} aria-hidden="true" />
            )}
            {busy ? "Locating…" : "Use my location"}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="flex min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)] shrink-0 items-center justify-center rounded-full text-text-tertiary hover:text-text-primary"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
