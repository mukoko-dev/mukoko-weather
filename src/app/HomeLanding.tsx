"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { WeatherLocation } from "@/lib/locations";
import { detectUserLocation } from "@/lib/geolocation";
import { MapPinIcon, SearchIcon, NavigationIcon } from "@/lib/weather-icons";
import { WeatherLoadingScene } from "@/components/weather/WeatherLoadingScene";

interface Props {
  detectedLocation: WeatherLocation | null;
}

type GpsState = "idle" | "detecting" | "denied" | "error";

const REDIRECT_DELAY_MS = 2000;

/**
 * Home landing — three-stage location pipeline:
 * 1. IP geo detected (server-side, no prompt): weather scene + "Taking you to [City]..." countdown
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

  // ── Stage 1: IP geo detected — full weather scene with countdown ──
  if (detectedLocation && !cancelled.current) {
    return (
      <WeatherLoadingScene
        slug={detectedLocation.slug}
        statusText={`Taking you to ${detectedLocation.name}…`}
        action={
          <div className="flex flex-col items-center gap-3">
            <div
              className="h-1 w-32 overflow-hidden rounded-full bg-white/20"
              role="progressbar"
              aria-label={`Redirecting in ${countdown} second${countdown !== 1 ? "s" : ""}`}
              aria-valuenow={REDIRECT_DELAY_MS - countdown * 1000}
              aria-valuemin={0}
              aria-valuemax={REDIRECT_DELAY_MS}
            >
              <div
                className="h-full rounded-full bg-white/80 transition-all"
                style={{ width: `${((REDIRECT_DELAY_MS - countdown * 1000) / REDIRECT_DELAY_MS) * 100}%`, transitionDuration: "1s" }}
              />
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleGps}
                className="press-scale inline-flex min-h-[var(--touch-target-min)] items-center gap-1.5 rounded-[var(--radius-button)] bg-white/15 px-4 py-2 text-sm font-medium text-white/90 backdrop-blur-sm transition-all hover:bg-white/25"
              >
                <NavigationIcon size={13} aria-hidden="true" />
                Use GPS instead
              </button>
              <Link
                href="/explore"
                onClick={handleCancel}
                className="press-scale inline-flex min-h-[var(--touch-target-min)] items-center gap-1.5 rounded-[var(--radius-button)] bg-white/15 px-4 py-2 text-sm font-medium text-white/90 backdrop-blur-sm transition-all hover:bg-white/25"
              >
                <SearchIcon size={13} aria-hidden="true" />
                Choose a city
              </Link>
            </div>
          </div>
        }
      />
    );
  }

  // ── Stage 2: GPS detecting — full weather scene while waiting ──
  if (gpsState === "detecting") {
    return (
      <WeatherLoadingScene
        statusText="Detecting your location…"
      />
    );
  }

  // ── Stages 2+3: No IP geo or GPS done — city chooser ──
  return (
    <main
      id="main-content"
      className="flex min-h-[calc(100dvh-4rem)] flex-col items-center justify-center px-4 py-12"
      aria-label="Location selection"
    >
      <div className="w-full max-w-sm space-y-8 text-center">
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
              className="kudu press-scale"
            >
              <NavigationIcon size={15} aria-hidden="true" />
              Use my current location
            </button>
            <Link href="/explore" className="impala press-scale">
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
      </div>
    </main>
  );
}
