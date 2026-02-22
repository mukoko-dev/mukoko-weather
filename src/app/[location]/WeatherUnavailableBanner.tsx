"use client";

import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

export function WeatherUnavailableBanner() {
  // role="status" overrides Alert's default role="alert" — this banner is
  // informational (not urgent), so polite live region is correct.
  return (
    <Alert variant="warning" role="status" aria-live="polite" className="mb-6 border-warmth bg-warmth/10">
      <AlertTitle className="text-warmth">
        Live weather data temporarily unavailable
      </AlertTitle>
      <AlertDescription>
        <p className="text-text-secondary">
          Our weather providers are not responding. Showing seasonal estimates
          for this location.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-2 text-sm font-medium text-primary transition-colors hover:text-primary/80"
        >
          Refresh now
        </button>
      </AlertDescription>
    </Alert>
  );
}
