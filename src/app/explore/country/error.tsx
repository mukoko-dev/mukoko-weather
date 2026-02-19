"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { reportErrorToAnalytics } from "@/lib/observability";

export default function ExploreCountryError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Country explore error:", error);
    reportErrorToAnalytics(`explore-country:${error.message}`, false);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <h1 className="font-heading text-3xl font-bold text-text-primary">
        Could not load countries
      </h1>
      <p className="mt-4 max-w-md text-center text-text-secondary">
        There was a problem loading the country list. This is usually a temporary issue.
      </p>
      <div className="mt-8 flex flex-col items-center gap-3">
        <Button size="lg" onClick={reset}>
          Try again
        </Button>
        <Button variant="outline" size="lg" asChild>
          <Link href="/explore">Back to Explore</Link>
        </Button>
      </div>
    </div>
  );
}
