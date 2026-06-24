"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { WeatherLocation } from "@/lib/locations";
import { detectUserLocation } from "@/lib/geolocation";
import { MapPinIcon, SearchIcon, NavigationIcon } from "@/lib/weather-icons";

interface Props {
  detectedLocation: WeatherLocation | null;
}

type GpsState = "idle" | "detecting" | "denied" | "error";

const REDIRECT_DELAY_MS = 2000;

/**
 * Home landing — three-stage location pipeline:
 * 1. IP geo detected (server-side, no prompt): "Taking you to [City]..." countdown
 * 2. "Use my current location" button: explicit browser GPS (user-triggered only)
 * 3. "Browse all locations": search / explore
 */
export function HomeLanding({ detectedLocation }: Props) {
  const router = useRouter();
  const [countdown, setCountdown] = useState(Math.ceil(REDIRECT_DELAY_MS / 1000));
  const [gpsState, setGpsState] = useState<GpsState>("idle");
  const cancelled = useRef(false);

  useEffect(() => {
    if (!detectedLocation || cancelled.current) return;

    const redirectTimer = setTimeout(() => {
      if (!cancelled.current) router.replace(`/${detectedLocation.slug}`);
    }, REDIRECT_DELAY_MS);

    const countdownInterval = setInterval(() => {
      setCountdown((c) => Math.max(0, c - 1));
    }, 1000);

    return () => {
      clearTimeout(redirectTimer);
      clearInterval(countdownInterval);
    };
  }, [detectedLocation, router]);

  const handleCancel = () => { cancelled.current = true; };

  const handleGps = async () => {
    setGpsState("detecting");
    cancelled.current = true;
    try {
      const result = await detectUserLocation();
      if ((result.status === "success" || result.status === "created") && result.location) {
        router.replace(`/${result.location.slug}`);
      } else if (result.status === "denied") {
        setGpsState("denied");
      } else {
        setGpsState("error");
      }
    } catch {
      setGpsState("error");
    }
  };

  return (
    <main
      id="main-content"
      className="flex min-h-[calc(100dvh-4rem)] flex-col items-center justify-center px-4 py-12"
      aria-label="Location selection"
    >
      <div className="w-full max-w-sm space-y-8 text-center">

        {detectedLocation ? (
          /* ── Stage 1: IP geo detected ── */
          <section aria-label="Detected location" className="animate-fade-in space-y-6">
            <div className="flex flex-col items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10" aria-hidden="true">
                <MapPinIcon size={22} className="text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium text-text-secondary">Taking you to</p>
                <h1 className="mt-0.5 text-2xl font-semibold text-text-primary">{detectedLocation.name}</h1>
                <p className="mt-0.5 text-sm text-text-tertiary">{detectedLocation.province}</p>
              </div>
            </div>

            <div
              className="mx-auto h-1 w-32 overflow-hidden rounded-full bg-surface-dim"
              role="progressbar"
              aria-label={`Redirecting in ${countdown} second${countdown !== 1 ? "s" : ""}`}
              aria-valuenow={REDIRECT_DELAY_MS - countdown * 1000}
              aria-valuemin={0}
              aria-valuemax={REDIRECT_DELAY_MS}
            >
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${((REDIRECT_DELAY_MS - countdown * 1000) / REDIRECT_DELAY_MS) * 100}%`, transitionDuration: "1s" }}
              />
            </div>

            <div className="flex flex-col gap-3">
              <button
                type="button"
                onClick={handleGps}
                disabled={gpsState === "detecting"}
                className="press-scale inline-flex min-h-[var(--touch-target-min)] items-center justify-center gap-2 rounded-[var(--radius-button)] border border-text-tertiary/20 px-5 py-3 text-sm font-medium text-text-secondary transition-all hover:border-text-tertiary/40 hover:bg-surface-card hover:text-text-primary disabled:opacity-50"
              >
                <NavigationIcon size={15} aria-hidden="true" />
                {gpsState === "detecting" ? "Detecting…" : "Use my current location"}
              </button>
              <Link
                href="/explore"
                onClick={handleCancel}
                className="press-scale inline-flex min-h-[var(--touch-target-min)] items-center justify-center gap-2 rounded-[var(--radius-button)] border border-text-tertiary/20 px-5 py-3 text-sm font-medium text-text-secondary transition-all hover:border-text-tertiary/40 hover:bg-surface-card hover:text-text-primary"
              >
                <SearchIcon size={15} aria-hidden="true" />
                Choose a different city
              </Link>
            </div>

            {(gpsState === "denied" || gpsState === "error") && (
              <p className="text-sm text-severity-moderate" role="alert">
                {gpsState === "denied" ? "Location access denied — please search for your city." : "Could not detect location — please search for your city."}
              </p>
            )}
          </section>
        ) : (
          /* ── Stages 2 + 3: No IP geo — GPS button + browse ── */
          <section aria-label="Find your location" className="animate-fade-in space-y-6">
            <div>
              <h1 className="text-2xl font-semibold text-text-primary">Find your weather</h1>
              <p className="mt-2 text-sm text-text-secondary">Use your device location or search for any city worldwide.</p>
            </div>

            <div className="flex flex-col gap-3">
              <button
                type="button"
                onClick={handleGps}
                disabled={gpsState === "detecting"}
                className="press-scale inline-flex min-h-[var(--touch-target-min)] items-center justify-center gap-2 rounded-[var(--radius-button)] bg-primary px-5 py-3 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/90 hover:shadow-md disabled:opacity-50"
              >
                <NavigationIcon size={15} aria-hidden="true" />
                {gpsState === "detecting" ? "Detecting…" : "Use my current location"}
              </button>
              <Link
                href="/explore"
                className="press-scale inline-flex min-h-[var(--touch-target-min)] items-center justify-center gap-2 rounded-[var(--radius-button)] border border-text-tertiary/20 px-5 py-3 text-sm font-medium text-text-secondary transition-all hover:border-text-tertiary/40 hover:bg-surface-card hover:text-text-primary"
              >
                <SearchIcon size={15} aria-hidden="true" />
                Browse all locations
              </Link>
            </div>

            {(gpsState === "denied" || gpsState === "error") && (
              <p className="text-sm text-severity-moderate" role="alert">
                {gpsState === "denied" ? "Location access denied — please search for your city." : "Could not detect location — please search for your city."}
              </p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
