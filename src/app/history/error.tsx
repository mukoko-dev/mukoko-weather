"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function HistoryError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("History page error:", error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <h1 className="font-display text-4xl font-bold text-text-primary">
        History Unavailable
      </h1>
      <p className="mt-4 max-w-md text-center text-text-secondary">
        We couldn&apos;t load historical weather data right now. This may be a
        temporary database issue.
      </p>
      <div className="mt-8 flex gap-4">
        <button
          onClick={reset}
          className="rounded-[var(--radius-badge)] bg-primary px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-primary"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-[var(--radius-badge)] border border-border-default px-6 py-3 text-sm font-semibold text-text-primary transition-colors hover:bg-surface-card focus-visible:outline-2 focus-visible:outline-primary"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
