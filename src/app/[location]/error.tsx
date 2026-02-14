"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getRetryCount, setRetryCount, clearRetryCount, MAX_RETRIES } from "@/lib/error-retry";

export default function LocationError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [exhausted, setExhausted] = useState(() => getRetryCount() >= MAX_RETRIES);

  useEffect(() => {
    console.error("Weather page error:", error);
  }, [error]);

  const handleRetry = () => {
    const count = getRetryCount() + 1;
    setRetryCount(count);

    if (count >= MAX_RETRIES) {
      setExhausted(true);
      return;
    }

    reset();
  };

  const handleNavigate = () => {
    clearRetryCount();
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <h1 className="font-heading text-4xl font-bold text-text-primary">
        Weather Unavailable
      </h1>
      <p className="mt-4 max-w-md text-center text-text-secondary">
        {exhausted
          ? "This location\u2019s weather data is temporarily unavailable. Try a different location or check back later."
          : "We couldn\u2019t load weather data right now. This is usually a temporary issue with our weather providers."}
      </p>

      <div className="mt-8 flex flex-col items-center gap-3">
        {!exhausted && (
          <button
            onClick={handleRetry}
            className="rounded-[var(--radius-badge)] bg-primary px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-primary"
          >
            Try again
          </button>
        )}

        <Link
          href="/"
          onClick={handleNavigate}
          className="rounded-[var(--radius-badge)] border border-border-default px-6 py-3 text-sm font-semibold text-text-primary transition-colors hover:bg-surface-card focus-visible:outline-2 focus-visible:outline-primary"
        >
          Go to Harare weather
        </Link>

        <Link
          href="/history"
          onClick={handleNavigate}
          className="text-sm text-text-tertiary transition-colors hover:text-text-secondary"
        >
          View historical data instead
        </Link>
      </div>
    </div>
  );
}
