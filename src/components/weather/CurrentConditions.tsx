"use client";

import { useState, useEffect, type ReactNode } from "react";
import { ShareIcon, NavigationIcon } from "@/lib/weather-icons";
import {
  weatherCodeToInfo,
  type CurrentWeather,
  type DailyWeather,
} from "@/lib/weather";
import { useAppStore } from "@/lib/store";
import {
  formatHighLow,
  heroBadgeLabel,
  heroEyebrowBadges,
  isHomeLocation,
  type HeroBadge,
} from "@/lib/hero";

const BASE_URL = "https://weather.mukoko.com";

interface Props {
  current: CurrentWeather;
  locationName: string;
  daily?: DailyWeather;
  slug?: string;
  /** GPS-confirmed current location (silent-URL home) — shows the
   *  MY LOCATION eyebrow above the location name, Apple Weather style. */
  isCurrentLocation?: boolean;
  /** Quiet content rendered below the hero (the season line on the
   *  location page). Kept as a slot so the hero stays a single block. */
  footer?: ReactNode;
}

/** Small house glyph for the HOME eyebrow — currentColor, decorative. */
function HomeGlyph() {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5.5 10v10h13V10" />
    </svg>
  );
}

function EyebrowBadge({ badge }: { badge: HeroBadge }) {
  return (
    <span className="inline-flex items-center gap-1">
      {badge === "current" ? (
        <NavigationIcon size={11} aria-hidden="true" />
      ) : (
        <HomeGlyph />
      )}
      {heroBadgeLabel(badge)}
    </span>
  );
}

export function CurrentConditions({
  current,
  locationName,
  daily,
  slug,
  isCurrentLocation = false,
  footer,
}: Props) {
  const info = weatherCodeToInfo(current.weather_code);
  const temperature = Math.round(current.temperature_2m);
  // Guard empty daily arrays — daily.temperature_2m_max[0] would be undefined
  // and the formatter returns null instead of "H:NaN°".
  const highLow = formatHighLow(
    daily?.temperature_2m_max?.[0],
    daily?.temperature_2m_min?.[0],
  );
  // homeLocation is a store field added by another agent; read it defensively
  // so this component works whether or not the field exists yet.
  const homeLocation = useAppStore(
    (s) => (s as { homeLocation?: string | null }).homeLocation ?? null,
  );
  const badges = heroEyebrowBadges(
    isCurrentLocation,
    isHomeLocation(slug, homeLocation),
  );

  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  useEffect(() => {
    if (!copyFailed) return;
    const t = setTimeout(() => setCopyFailed(false), 2000);
    return () => clearTimeout(t);
  }, [copyFailed]);

  function handleShare() {
    const url = slug ? `${BASE_URL}/${slug}` : window.location.href;
    const shareData = {
      title: `${locationName} Weather`,
      text: `Check the weather in ${locationName} on mukoko weather`,
      url,
    };
    if (typeof navigator !== "undefined" && navigator.share) {
      navigator.share(shareData).catch(() => undefined);
    } else {
      navigator.clipboard
        .writeText(url)
        .then(() => {
          setCopied(true);
        })
        .catch(() => {
          setCopyFailed(true);
        });
    }
  }

  return (
    <section
      aria-labelledby="current-conditions-heading"
      className="relative px-5 pt-6 pb-4 text-center sm:px-7 sm:pt-10"
    >
      {/* Hero — iOS Weather style: one centred column, nothing competing.
          Deliberately NOT a card: it reads directly over the page-level
          WeatherBackdrop sky, and the backdrop's scrim keeps the text
          tokens readable. */}
      <div className="relative z-10 flex flex-col items-center">
        {badges.length > 0 && (
          <p className="mb-1 flex flex-wrap items-center justify-center gap-x-3 text-sm font-semibold uppercase tracking-widest text-text-tertiary">
            {badges.map((badge) => (
              <EyebrowBadge key={badge} badge={badge} />
            ))}
          </p>
        )}
        <h2
          id="current-conditions-heading"
          className="text-xl font-medium text-text-secondary sm:text-2xl"
        >
          {locationName}
        </h2>
        <p className="mt-1 flex items-start justify-center leading-none tracking-tighter text-text-primary">
          <span className="sr-only">{temperature} degrees Celsius</span>
          <span
            className="font-sans text-8xl font-normal sm:text-9xl"
            aria-hidden="true"
          >
            {temperature}
          </span>
          <span
            className="font-sans text-5xl font-normal text-text-secondary sm:text-6xl"
            aria-hidden="true"
          >
            °
          </span>
        </p>
        <p className="mt-2 text-xl font-semibold text-text-primary sm:text-2xl">
          {info.label}
        </p>
        {highLow && (
          <p className="mt-1 whitespace-pre text-lg text-text-secondary">
            {highLow}
          </p>
        )}
        <button
          type="button"
          onClick={handleShare}
          aria-label={`Share weather for ${locationName}`}
          className="press-scale mt-4 flex min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)] items-center justify-center gap-1.5 rounded-[var(--radius-input)] px-3 text-base text-text-secondary transition-colors hover:bg-surface-elevated hover:text-text-primary"
        >
          <ShareIcon size={16} aria-hidden="true" />
          <span className="sr-only sm:not-sr-only">
            {copied ? "Copied!" : copyFailed ? "Copy failed" : "Share"}
          </span>
        </button>
        {footer && (
          <div className="relative z-10 mt-6 flex justify-center">{footer}</div>
        )}
      </div>
    </section>
  );
}
