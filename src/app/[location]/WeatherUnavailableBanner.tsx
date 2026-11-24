"use client";

import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { DismissibleBanner } from "@/components/ui/dismissible-banner";
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
  /**
   * The banner's own spacing: the place page spaces its stack itself, the
   * other pages leave a gap below it.
   */
  className?: string;
}

export function WeatherUnavailableBanner({
  banner = SEASONAL_ESTIMATE,
  onRetry,
  className = "mb-6",
}: Props) {
  // role="status" overrides Alert's default role="alert" — this banner is
  // informational (not urgent), so polite live region is correct.
  //
  // It can be closed until the page is reloaded; a different title or reason
  // (the fetch failing for another cause, the data going stale) is a different
  // message and shows the banner again.
  return (
    <DismissibleBanner
      id={`unavailable:${banner.title}:${banner.reason ?? ""}`}
      closeLabel="Dismiss weather notice"
      className={className}
    >
      <Alert
        variant="warning"
        role="status"
        aria-live="polite"
        className="border-warmth bg-warmth/10 pr-12"
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
    </DismissibleBanner>
  );
}
