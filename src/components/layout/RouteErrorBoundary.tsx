"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { reportErrorToAnalytics, buildIssueUrl } from "@/lib/observability";
import { getRetryCount, setRetryCount, clearRetryCount, MAX_RETRIES } from "@/lib/error-retry";

/** The props Next.js passes to every route-level error.tsx. */
export interface RouteErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

interface RouteErrorBoundaryProps extends RouteErrorProps {
  /** Heading, e.g. "Weather Unavailable" */
  title: string;
  /** Body copy for the first few failures */
  message: string;
  /** Body copy once retries are exhausted (used with retryTracking) */
  exhaustedMessage?: string;
  /** Analytics/observability source key, e.g. "location" — prefixes the GA4 exception and tags the GitHub issue */
  source: string;
  /** Human label used for the console log and the GitHub issue title, e.g. "Weather page error" */
  label: string;
  /**
   * sessionStorage-tracked retry cap (max 3), fatal analytics flag, and the
   * "Report this issue" link. On for full page boundaries (default); off for
   * lightweight browse pages where a plain retry suffices.
   */
  retryTracking?: boolean;
  /** Escape-hatch destination (default "/") */
  homeHref?: string;
  /** Escape-hatch label (default "Go home") */
  homeLabel?: string;
  /** Optional secondary links, e.g. "View historical data instead" */
  extraLinks?: { label: string; href: string }[];
}

/**
 * Shared route-level error boundary body. Every route error.tsx renders this
 * with its own copy — previously each of the 8 files reimplemented the same
 * retry-tracking logic, callbacks, and JSX shell line-for-line (issue #102).
 */
export function RouteErrorBoundary({
  error,
  reset,
  title,
  message,
  exhaustedMessage,
  source,
  label,
  retryTracking = true,
  homeHref = "/",
  homeLabel = "Go home",
  extraLinks,
}: RouteErrorBoundaryProps) {
  const [exhausted, setExhausted] = useState(
    () => retryTracking && getRetryCount() >= MAX_RETRIES,
  );

  useEffect(() => {
    console.error(`${label}:`, error);
    // Retry-tracked boundaries guard whole-page failures — report as fatal.
    reportErrorToAnalytics(`${source}:${error.message}`, retryTracking);
  }, [error, label, source, retryTracking]);

  const handleRetry = () => {
    if (!retryTracking) {
      reset();
      return;
    }
    const count = getRetryCount() + 1;
    setRetryCount(count);

    if (count >= MAX_RETRIES) {
      setExhausted(true);
      return;
    }

    reset();
  };

  const handleNavigate = () => {
    if (retryTracking) clearRetryCount();
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <h1 className="font-heading text-4xl font-bold text-text-primary">{title}</h1>
      <p className="mt-4 max-w-md text-center text-text-secondary">
        {exhausted && exhaustedMessage ? exhaustedMessage : message}
      </p>
      <div className="mt-8 flex flex-col items-center gap-3">
        {!exhausted && (
          <Button size="lg" onClick={handleRetry}>
            Try again
          </Button>
        )}
        <Button variant="outline" size="lg" asChild>
          <Link href={homeHref} onClick={handleNavigate}>
            {homeLabel}
          </Link>
        </Button>
        {extraLinks?.map((link) => (
          <Button key={link.href} variant="link" asChild>
            <Link href={link.href} onClick={handleNavigate}>
              {link.label}
            </Link>
          </Button>
        ))}
        {retryTracking && (
          <a
            href={buildIssueUrl({
              title: label,
              source,
              message: error.message,
              page: typeof window !== "undefined" ? window.location.pathname : undefined,
              digest: error.digest,
            })}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 text-base text-text-tertiary underline hover:text-text-secondary transition-colors"
          >
            Report this issue
          </a>
        )}
      </div>
    </div>
  );
}
