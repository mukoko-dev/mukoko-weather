"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { reportErrorToAnalytics } from "@/lib/observability";

export default function ProvinceDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Province detail error:", error);
    reportErrorToAnalytics(`explore-province-detail:${error.message}`, false);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <h1 className="font-heading text-3xl font-bold text-text-primary">
        Could not load province
      </h1>
      <p className="mt-4 max-w-md text-center text-text-secondary">
        There was a problem loading this province&apos;s data. This is usually a temporary issue.
      </p>
      <div className="mt-8 flex flex-col items-center gap-3">
        <Button size="lg" onClick={reset}>
          Try again
        </Button>
        <Button variant="outline" size="lg" asChild>
          <Link href="/explore/country">Browse all countries</Link>
        </Button>
      </div>
    </div>
  );
}
