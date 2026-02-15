"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { reportErrorToAnalytics, buildIssueUrl } from "@/lib/observability";
import { getRetryCount, setRetryCount, clearRetryCount, MAX_RETRIES } from "@/lib/error-retry";

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
    reportErrorToAnalytics(`global:${error.message}`, true);
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
          <Button size="lg" onClick={handleRetry}>
            Try again
          </Button>
        )}
        <Button variant="outline" size="lg" asChild>
          <Link href="/" onClick={handleNavigate}>
            Go home
          </Link>
        </Button>
        <a
          href={buildIssueUrl({
            title: "Application error",
            source: "global",
            message: error.message,
            page: typeof window !== "undefined" ? window.location.pathname : undefined,
            digest: error.digest,
          })}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 text-xs text-text-tertiary underline hover:text-text-secondary transition-colors"
        >
          Report this issue
        </a>
      </div>
    </div>
  );
}
