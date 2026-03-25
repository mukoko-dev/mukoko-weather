import type { Metadata } from "next";
import Link from "next/link";
import { CloudOff } from "lucide-react";

export const metadata: Metadata = {
  title: "Offline — mukoko weather",
  description: "You appear to be offline. Connect to the internet to get the latest weather data.",
  alternates: { canonical: "https://weather.mukoko.com/offline" },
};

export default function OfflinePage() {
  return (
    <main
      id="main-content"
      className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center"
    >
      <div className="mx-auto max-w-md space-y-6">
        <CloudOff className="mx-auto h-16 w-16 text-text-tertiary" aria-hidden="true" />
        <h1 className="text-2xl font-bold text-text-primary">
          You&apos;re offline
        </h1>
        <p className="text-text-secondary">
          mukoko weather needs an internet connection to fetch the latest data.
          Previously viewed locations may still be available from cache.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link
            href="/"
            className="inline-flex min-h-[var(--touch-target-min)] items-center justify-center rounded-[var(--radius-button)] bg-primary px-6 text-base font-medium text-primary-foreground"
          >
            Try again
          </Link>
        </div>
        <p className="text-xs text-text-tertiary">
          Tip: Save your favourite locations for offline access
        </p>
      </div>
    </main>
  );
}
