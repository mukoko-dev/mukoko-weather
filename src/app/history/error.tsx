"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getRetryCount, setRetryCount, clearRetryCount, MAX_RETRIES } from "@/lib/error-retry";

export default function HistoryError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [exhausted, setExhausted] = useState(() => getRetryCount() >= MAX_RETRIES);

  useEffect(() => {
    console.error("History page error:", error);
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
        History Unavailable
      </h1>
      <p className="mt-4 max-w-md text-center text-text-secondary">
        {exhausted
          ? "Historical data is temporarily unavailable. Please try again later."
          : "We couldn\u2019t load historical weather data right now. This may be a temporary database issue."}
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
      </div>
    </div>
  );
}
