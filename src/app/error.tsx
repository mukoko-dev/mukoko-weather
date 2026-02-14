"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const RETRY_STORAGE_KEY = "mukoko-error-retries";
const MAX_RETRIES = 3;

function getRetryCount(): number {
  try {
    const stored = sessionStorage.getItem(RETRY_STORAGE_KEY);
    if (!stored) return 0;
    const data = JSON.parse(stored);
    if (data.url === window.location.href) return data.count;
    return 0;
  } catch {
    return 0;
  }
}

function setRetryCount(count: number): void {
  try {
    sessionStorage.setItem(
      RETRY_STORAGE_KEY,
      JSON.stringify({ url: window.location.href, count }),
    );
  } catch {
    // sessionStorage unavailable
  }
}

function clearRetryCount(): void {
  try {
    sessionStorage.removeItem(RETRY_STORAGE_KEY);
  } catch {
    // sessionStorage unavailable
  }
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [exhausted, setExhausted] = useState(() => getRetryCount() >= MAX_RETRIES);

  useEffect(() => {
    console.error("Application error:", error);
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
        Something went wrong
      </h1>
      <p className="mt-4 max-w-md text-center text-text-secondary">
        {exhausted
          ? "This page is experiencing persistent issues. Please try a different page or check back later."
          : "An unexpected error occurred. Please try again or return to the home page."}
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
          Go home
        </Link>
      </div>
    </div>
  );
}
