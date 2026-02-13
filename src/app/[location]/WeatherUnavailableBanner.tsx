"use client";

export function WeatherUnavailableBanner() {
  return (
    <div
      role="alert"
      className="mb-6 rounded-[var(--radius-card)] border-l-4 border-warmth bg-warmth/10 p-4"
    >
      <p className="text-sm font-semibold text-warmth">
        Live weather data temporarily unavailable
      </p>
      <p className="mt-1 text-sm text-text-secondary">
        Our weather providers are not responding. Showing seasonal estimates
        for this location.
      </p>
      <button
        onClick={() => window.location.reload()}
        className="mt-2 text-sm font-medium text-primary transition-colors hover:text-primary/80"
      >
        Refresh now
      </button>
    </div>
  );
}
