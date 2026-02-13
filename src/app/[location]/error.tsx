"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function LocationError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Weather page error:", error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <h1 className="font-display text-4xl font-bold text-text-primary">
        Weather Unavailable
      </h1>
      <p className="mt-4 max-w-md text-center text-text-secondary">
        We couldn&apos;t load weather data right now. This is usually a
        temporary issue with our weather providers.
      </p>
      <button
        onClick={reset}
        className="mt-8 rounded-[var(--radius-badge)] bg-primary px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-primary"
      >
        Try again
      </button>
      <Link
        href="/"
        className="mt-4 text-sm text-text-tertiary transition-colors hover:text-text-secondary"
      >
        Go to Harare weather
      </Link>
    </div>
  );
}
