"use client";

import { useAppStore, hasStoreHydrated } from "@/lib/store";
import { MapPinIcon, SparklesIcon } from "@/lib/weather-icons";

/**
 * Inline welcome banner for first-time visitors.
 *
 * Replaces the old auto-opening modal approach which caused:
 *   Loading → Dashboard → Modal overlay → Loading → Dashboard
 *
 * Now the flow is:
 *   Loading → Dashboard with welcome banner → (optional modal) → done
 *
 * The banner sits above the weather grid, is dismissible, and lets the
 * user personalize on their own terms rather than interrupting them.
 *
 * Waits for Zustand store hydration before rendering to prevent a flash
 * of the welcome banner for returning users whose hasOnboarded=true is
 * still loading from localStorage.
 */
export function WelcomeBanner({
  locationName,
  onChangeLocation,
}: {
  locationName: string;
  onChangeLocation: () => void;
}) {
  const hasOnboarded = useAppStore((s) => s.hasOnboarded);
  const completeOnboarding = useAppStore((s) => s.completeOnboarding);

  // Don't render until the store has hydrated from localStorage —
  // prevents a flash for returning users whose hasOnboarded is true.
  if (!hasStoreHydrated()) return null;
  if (hasOnboarded) return null;

  return (
    <section
      aria-label="Welcome to mukoko weather"
      className="mb-6 rounded-[var(--radius-card)] border border-primary/20 bg-primary/5 p-4 sm:p-5"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10" aria-hidden="true">
          <SparklesIcon size={16} className="text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-primary">
            Welcome to mukoko weather
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            You&apos;re viewing weather for <strong>{locationName}</strong>. Pick your own location and activities for personalised forecasts.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onChangeLocation}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 min-h-[44px]"
            >
              <MapPinIcon size={14} />
              Personalise
            </button>
            <button
              type="button"
              onClick={completeOnboarding}
              className="inline-flex items-center rounded-full border border-text-tertiary/20 px-3.5 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-card min-h-[44px]"
            >
              Continue with {locationName}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
