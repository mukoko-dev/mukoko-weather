"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { WeatherLocation } from "@/lib/locations";
import { MapPinIcon, SearchIcon } from "@/lib/weather-icons";

interface Props {
  detectedLocation: WeatherLocation | null;
}

const REDIRECT_DELAY_MS = 2000;

/**
 * Home landing page — shown when the user has no lastLocation cookie.
 *
 * Two states:
 * - Detected city (via Vercel IP geo): shows city name + countdown → auto-redirects
 * - No detection (local dev, VPN, etc.): shows "Where are you?" with explore links
 *
 * Replaces HomeRedirect — no browser permission prompt, no loading spinner.
 */
export function HomeLanding({ detectedLocation }: Props) {
  const router = useRouter();
  const [countdown, setCountdown] = useState(Math.ceil(REDIRECT_DELAY_MS / 1000));
  const cancelled = useRef(false);

  useEffect(() => {
    if (!detectedLocation || cancelled.current) return;

    const redirectTimer = setTimeout(() => {
      if (!cancelled.current) {
        router.replace(`/${detectedLocation.slug}`);
      }
    }, REDIRECT_DELAY_MS);

    const countdownInterval = setInterval(() => {
      setCountdown((c) => Math.max(0, c - 1));
    }, 1000);

    return () => {
      clearTimeout(redirectTimer);
      clearInterval(countdownInterval);
    };
  }, [detectedLocation, router]);

  const handleCancel = () => {
    cancelled.current = true;
  };

  return (
    <main
      id="main-content"
      className="flex min-h-[calc(100dvh-4rem)] flex-col items-center justify-center px-4 py-12"
      aria-label="Location selection"
    >
      <div className="w-full max-w-sm space-y-8 text-center">

        {detectedLocation ? (
          /* ── Detected city: countdown + redirect ── */
          <section
            aria-label="Detected location"
            className="animate-fade-in space-y-6"
          >
            <div className="flex flex-col items-center gap-3">
              <div
                className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10"
                aria-hidden="true"
              >
                <MapPinIcon size={22} className="text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium text-text-secondary">
                  Taking you to
                </p>
                <h1 className="mt-0.5 text-2xl font-semibold text-text-primary">
                  {detectedLocation.name}
                </h1>
                <p className="mt-0.5 text-sm text-text-tertiary">
                  {detectedLocation.province}
                </p>
              </div>
            </div>

            {/* Progress bar */}
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
                style={{
                  width: `${((REDIRECT_DELAY_MS - countdown * 1000) / REDIRECT_DELAY_MS) * 100}%`,
                  transitionDuration: "1s",
                }}
              />
            </div>

            <Link
              href="/explore"
              onClick={handleCancel}
              className="press-scale inline-flex min-h-[var(--touch-target-min)] items-center gap-1.5 rounded-[var(--radius-button)] border border-text-tertiary/20 px-4 py-2 text-sm font-medium text-text-secondary transition-all hover:border-text-tertiary/40 hover:bg-surface-card hover:text-text-primary"
            >
              Choose a different city
            </Link>
          </section>
        ) : (
          /* ── No detection: city chooser ── */
          <section
            aria-label="Choose a city"
            className="animate-fade-in space-y-6"
          >
            <div>
              <h1 className="text-2xl font-semibold text-text-primary">
                Where are you?
              </h1>
              <p className="mt-2 text-sm text-text-secondary">
                Find weather for your location or browse cities worldwide.
              </p>
            </div>

            <div className="flex flex-col gap-3">
              <Link
                href="/explore"
                className="press-scale inline-flex min-h-[var(--touch-target-min)] items-center justify-center gap-2 rounded-[var(--radius-button)] bg-primary px-5 py-3 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/90 hover:shadow-md"
              >
                <SearchIcon size={15} aria-hidden="true" />
                Browse locations
              </Link>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
