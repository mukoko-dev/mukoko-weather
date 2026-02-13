"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const retryCount = useRef(0);

  useEffect(() => {
    console.error("Application error:", error);
  }, [error]);

  const handleRetry = () => {
    retryCount.current += 1;
    if (retryCount.current >= 2) {
      // After 2 failed retries, do a full page reload to clear any
      // corrupted client state
      window.location.reload();
      return;
    }
    reset();
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <h1 className="font-display text-4xl font-bold text-text-primary">
        Something went wrong
      </h1>
      <p className="mt-4 max-w-md text-center text-text-secondary">
        An unexpected error occurred. Please try again or return to the home
        page.
      </p>
      <div className="mt-8 flex gap-4">
        <button
          onClick={handleRetry}
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
