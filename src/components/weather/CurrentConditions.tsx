"use client";

import { useState, useEffect, useMemo, type ReactNode } from "react";
import {
  ShareIcon,
  NavigationIcon,
  WeatherIcon,
  nightIcon,
} from "@/lib/weather-icons";
import {
  weatherCodeToInfo,
  type CurrentWeather,
  type DailyWeather,
  type HourlyWeather,
} from "@/lib/weather";
import { useAppStore } from "@/lib/store";
import { getActivityById } from "@/lib/activities";
import { feasibilitySeries } from "@/lib/activity-feasibility";
import { fetchSuitabilityRules } from "@/lib/suitability-cache";
import type { SuitabilityRuleDoc } from "@/lib/db";
import {
  SKY_CLASS,
  activityDotClass,
  formatFeelsLike,
  formatHighLow,
  heroActivityClause,
  heroBadgeLabel,
  heroEyebrowBadges,
  heroOutlook,
  isHomeLocation,
  skyFamily,
  type HeroBadge,
} from "@/lib/hero";

const BASE_URL = "https://weather.mukoko.com";

interface Props {
  current: CurrentWeather;
  locationName: string;
  daily?: DailyWeather;
  /** Hourly forecast — powers the one-sentence outlook and the activity clause. */
  hourly?: HourlyWeather;
  /** The location's UTC offset (payload `utc_offset_seconds`) — the outlook
   *  and activity clause read "now" and hour labels in the PLACE's time. */
  utcOffsetSeconds?: number;
  slug?: string;
  /** GPS-confirmed current location (silent-URL home) — shows the
   *  MY LOCATION eyebrow above the location name. */
  isCurrentLocation?: boolean;
  /** Quiet content at the foot of the sky (the season line on the location
   *  page). Kept as a slot so the hero stays a single block. */
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
  hourly,
  utcOffsetSeconds,
  slug,
  isCurrentLocation = false,
  footer,
}: Props) {
  const info = weatherCodeToInfo(current.weather_code);
  const isDay = current.is_day === 1;
  const family = skyFamily(current.weather_code, isDay);
  const temperature = Math.round(current.temperature_2m);
  // Guard empty daily arrays — the formatter returns null instead of "H:NaN°".
  const highLow = formatHighLow(
    daily?.temperature_2m_max?.[0],
    daily?.temperature_2m_min?.[0],
  );
  const feels = formatFeelsLike(current.apparent_temperature);
  // homeLocation is a store field added by another agent; read it defensively
  // so this component works whether or not the field exists yet.
  const homeLocation = useAppStore(
    (s) => (s as { homeLocation?: string | null }).homeLocation ?? null,
  );
  const selectedActivities = useAppStore((s) => s.selectedActivities);
  const openMyWeather = useAppStore((s) => s.openMyWeather);
  const badges = heroEyebrowBadges(
    isCurrentLocation,
    isHomeLocation(slug, homeLocation),
  );
  const hasSelection = selectedActivities.length > 0;

  // Client-only clock. The server runs in UTC, so the "current hour" used by
  // the outlook and the activity clause is read after mount — no hydration drift.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => setNow(new Date()));
    return () => cancelAnimationFrame(id);
  }, []);

  // Suitability rules (module-level cache, 10-min TTL) — only needed when the
  // visitor has picked activities.
  const [dbRules, setDbRules] = useState<Map<string, SuitabilityRuleDoc>>(
    () => new Map(),
  );
  useEffect(() => {
    if (!hasSelection) return;
    let cancelled = false;
    fetchSuitabilityRules()
      .then((rules) => {
        if (cancelled || !rules.length) return;
        const map = new Map<string, SuitabilityRuleDoc>();
        for (const rule of rules) map.set(rule.key, rule);
        setDbRules(map);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [hasSelection]);

  const outlook = useMemo(
    () => (now ? heroOutlook(hourly, now, utcOffsetSeconds) : null),
    [hourly, now, utcOffsetSeconds],
  );

  // "For your activities": the first selected activity with a readable series.
  const activityLine = useMemo(() => {
    if (!now || !hourly || !hasSelection) return null;
    for (const id of selectedActivities) {
      const activity = getActivityById(id);
      if (!activity) continue;
      const clause = heroActivityClause(
        feasibilitySeries(activity, hourly, dbRules, 24, utcOffsetSeconds, now),
        utcOffsetSeconds,
      );
      if (clause) {
        return {
          label: activity.label,
          dot: activityDotClass(activity.category),
          clause,
        };
      }
    }
    return null;
  }, [
    now,
    hourly,
    hasSelection,
    selectedActivities,
    dbRules,
    utcOffsetSeconds,
  ]);

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
      data-sky-hero
      className="relative isolate"
    >
      {/* Open sky — no card. A full-bleed gradient band behind the hero,
          condition family × day/night (src/lib/hero.ts skyFamily); static CSS,
          so it never fights the fixed WeatherBackdrop, into which its lower
          edge fades. The content below stays in the page column. */}
      <div
        aria-hidden="true"
        data-sky={family}
        className={`kestrel ${SKY_CLASS[family]}`}
      />
      <div className="relative pt-1 pr-[env(safe-area-inset-right,0px)] pb-[var(--sky-fade)] pl-[env(safe-area-inset-left,0px)] text-left text-[var(--sky-fg)]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {badges.length > 0 && (
              <p className="mb-1 flex flex-wrap items-center gap-x-3 text-sm font-semibold uppercase tracking-widest">
                {badges.map((badge) => (
                  <EyebrowBadge key={badge} badge={badge} />
                ))}
              </p>
            )}
            <h2
              id="current-conditions-heading"
              className="font-heading text-2xl font-semibold break-words sm:text-3xl"
            >
              {locationName}
            </h2>
          </div>
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={handleShare}
              aria-label={`Share weather for ${locationName}`}
              className="kestrel-round"
            >
              <ShareIcon size={20} aria-hidden="true" />
            </button>
            <span
              role="status"
              className={
                copied || copyFailed
                  ? "absolute top-full right-0 mt-1 text-sm font-medium whitespace-nowrap"
                  : "sr-only"
              }
            >
              {copied ? "Link copied" : copyFailed ? "Copy failed" : ""}
            </span>
          </div>
        </div>
        <div className="mt-1 flex items-center justify-between gap-3">
          <p className="flex items-start leading-none tracking-tight">
            <span className="sr-only">{temperature} degrees Celsius</span>
            <span
              className="font-heading text-[clamp(5rem,26vw,6.5rem)] leading-[0.95] font-semibold tabular-nums"
              aria-hidden="true"
            >
              {temperature}
            </span>
            <span
              className="font-heading mt-[0.5rem] text-[clamp(2.25rem,12vw,3rem)] leading-none font-semibold"
              aria-hidden="true"
            >
              °
            </span>
          </p>
          <span aria-hidden="true" className="shrink-0">
            <WeatherIcon
              icon={isDay ? info.icon : nightIcon(info.icon)}
              size={56}
            />
          </span>
        </div>
        <p className="mt-1 text-xl font-semibold sm:text-2xl">{info.label}</p>
        {(highLow || feels) && (
          <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-lg font-medium tabular-nums">
            {highLow && <span className="whitespace-pre">{highLow}</span>}
            {highLow && feels && <span aria-hidden="true">·</span>}
            {feels && <span>{feels}</span>}
          </p>
        )}
        {outlook && (
          <p className="mt-3 max-w-[30ch] text-base leading-relaxed">
            {outlook}
          </p>
        )}
        {activityLine ? (
          <p className="mt-3 flex items-center gap-2 text-base font-semibold">
            <span
              aria-hidden="true"
              className={`size-2.5 shrink-0 rounded-full ring-2 ring-current ${activityLine.dot}`}
            />
            <span>
              {activityLine.label}: {activityLine.clause}
            </span>
          </p>
        ) : (
          !hasSelection && (
            <button
              type="button"
              onClick={() => openMyWeather("activities")}
              className="kestrel-link mt-1"
            >
              Pick activities for tailored advice
            </button>
          )
        )}
        {footer && <div className="mt-2 flex">{footer}</div>}
      </div>
    </section>
  );
}
