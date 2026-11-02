"use client";

import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { weatherBanner, type BannerView } from "@/lib/weather-banner";

const SEASONAL_ESTIMATE = weatherBanner({
  fallback: true,
  stale: false,
  live: { status: "idle", failure: null, attempt: 0, retryInMs: null },
});

interface Props {
  /**
   * What to say and why (`weatherBanner`). The location pages without a live
   * fetch of their own (atmosphere, forecast) pass nothing and get the plain
   * seasonal-estimate wording.
   */
  banner?: BannerView;
  /** "Try again": run the same fetch now. Without it the page reloads. */
  onRetry?: () => void;
}

export function WeatherUnavailableBanner({
  banner = SEASONAL_ESTIMATE,
  onRetry,
}: Props) {
  // role="status" overrides Alert's default role="alert" — this banner is
  // informational (not urgent), so polite live region is correct.
  return (
    <Alert
      variant="warning"
      role="status"
      aria-live="polite"
      className="mb-6 border-warmth bg-warmth/10"
    >
      <AlertTitle className="text-warmth">{banner.title}</AlertTitle>
      <AlertDescription>
        <p className="text-text-secondary">{banner.message}</p>
        {banner.reason && (
          <p className="mt-1 text-text-secondary" data-banner-reason>
            {banner.reason}
          </p>
        )}
        <button
          type="button"
          onClick={onRetry ?? (() => window.location.reload())}
          disabled={!banner.canRetry}
          aria-busy={!banner.canRetry}
          className="dikdik mt-2"
        >
          Try again
        </button>
      </AlertDescription>
    </Alert>
  );
}
