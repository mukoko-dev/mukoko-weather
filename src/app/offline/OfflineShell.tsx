"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CloudOff } from "lucide-react";
import { DeviceSnapshot } from "@/components/weather/DeviceSnapshot";
import { LAST_HOME_PLACE_KEY } from "@/lib/last-location";
import { recallPlace } from "@/lib/rxdb/weather-places";
import { readStorage } from "@/lib/safe-storage";
import { useAppStore } from "@/lib/store";
import type { DeviceView } from "@/lib/device-weather";

/**
 * The app shell when there is no network: the service worker answers a page
 * it has no copy of with this precached page. It paints the place the visitor
 * last looked at from the copy stored on the device (hero, hours, days), says
 * it is not live, and offers a way to try again. With nothing stored it says
 * so plainly.
 */
export function OfflineShell() {
  const selectedLocation = useAppStore((s) => s.selectedLocation);
  // undefined = still looking; null = nothing stored for any candidate.
  const [view, setView] = useState<DeviceView | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const candidates = [readStorage(LAST_HOME_PLACE_KEY), selectedLocation]
      .filter((slug): slug is string => !!slug)
      .filter((slug, i, all) => all.indexOf(slug) === i);
    void (async () => {
      for (const slug of candidates) {
        const found = await recallPlace(slug).catch(() => null);
        if (cancelled) return;
        if (found) {
          setView(found);
          return;
        }
      }
      if (!cancelled) setView(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedLocation]);

  const notice = (
    <div
      className={
        view
          ? "mx-auto max-w-7xl px-4 pb-[var(--mobile-nav-clearance)] sm:px-6 md:px-8"
          : "flex min-h-[60vh] flex-col items-center justify-center px-4 text-center"
      }
    >
      <div
        role="status"
        aria-live="polite"
        className="mx-auto max-w-md space-y-4 text-center"
      >
        {!view && (
          <CloudOff
            className="mx-auto h-16 w-16 text-text-tertiary"
            aria-hidden="true"
          />
        )}
        <h1
          className={view ? "giraffe" : "text-2xl font-bold text-text-primary"}
        >
          You&apos;re offline
        </h1>
        <p className="text-text-secondary">
          {view
            ? "This is the last weather saved on this device. It will update when you are back online."
            : view === null
              ? "mukoko weather needs an internet connection to fetch the latest data. Nothing is saved on this device yet."
              : "Looking for weather saved on this device…"}
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link href="/" className="kudu text-base">
            Try again
          </Link>
        </div>
      </div>
    </div>
  );

  // The device snapshot is its own <main>; without one this page is the <main>.
  return view ? (
    <>
      <DeviceSnapshot view={view} showHeader={false} />
      {notice}
    </>
  ) : (
    <main id="main-content">{notice}</main>
  );
}
