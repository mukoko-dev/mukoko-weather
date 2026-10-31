"use client";

import { useState, useEffect, useMemo, type ReactNode } from "react";
import { MobileMoreMenu } from "@/components/layout/MobileMoreMenu";
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
  activityDotClass,
  formatHighLowParts,
  heroActivityClause,
  heroLocalTime,
  heroBadgeLabel,
  heroEyebrowBadges,
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
  /** The breadcrumb trail, rendered at the left of the hero's top row. */
  breadcrumb?: ReactNode;
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
  breadcrumb,
}: Props) {
  const info = weatherCodeToInfo(current.weather_code);
  const isDay = current.is_day === 1;
  const family = skyFamily(current.weather_code, isDay);
  const temperature = Math.round(current.temperature_2m);
  // Guard empty daily arrays — the formatter returns null instead of "H:NaN°".
  const highLow = formatHighLowParts(
    daily?.temperature_2m_max?.[0],
    daily?.temperature_2m_min?.[0],
  );
  // homeLocation is a store field added by another agent; read it defensively
  // so this component works whether or not the field exists yet.
  const homeLocation = useAppStore(
    (s) => (s as { homeLocation?: string | null }).homeLocation ?? null,
  );
  const selectedActivities = useAppStore((s) => s.selectedActivities);
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

  const localTime = heroLocalTime(now, utcOffsetSeconds);

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
      data-sky={family}
      className="relative text-[var(--sky-fg)]"
    >
      {/* Top row — breadcrumb at the left, Share and (phones) the ⋯ menu at the
          right. On phones the site header is not drawn over the sky (see
          globals.css, [data-sky-hero]), so these controls are the page's top
          chrome. Round 48px controls: content stays distinct from controls. */}
      <div className="flex items-center justify-between gap-3 pt-1 pr-[env(safe-area-inset-right,0px)] pl-[env(safe-area-inset-left,0px)]">
        <div className="min-w-0 text-[0.8125rem] text-[var(--sky-fg-dim)]">
          {breadcrumb}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="relative">
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
          <div className="relative sm:hidden">
            <MobileMoreMenu
              buttonClassName="kestrel-round"
              iconClassName="text-[var(--sky-fg)]"
            />
          </div>
        </div>
      </div>
      <div className="flex flex-col items-center pt-4 pb-[26px] text-center">
        {/* Eyebrow: MY LOCATION / HOME, else the place's own clock. The line is
            always reserved so the clock arriving after mount never shifts
            the page. */}
        <p className="flex min-h-[1.125rem] flex-wrap items-center justify-center gap-x-2 font-mono text-xs font-medium uppercase tracking-[0.18em] text-[var(--sky-fg-dim)]">
          {badges.length > 0
            ? badges.map((badge, i) => (
                <span key={badge} className="inline-flex items-center gap-2">
                  {i > 0 && <span aria-hidden="true">·</span>}
                  <EyebrowBadge badge={badge} />
                </span>
              ))
            : localTime}
        </p>
        <h2
          id="current-conditions-heading"
          className="font-heading text-[2.25rem] leading-[1.15] font-medium break-words"
        >
          {locationName}
        </h2>
        <p className="mt-1 max-w-full font-sans text-[6.5rem] leading-none font-extralight tracking-[-2px] tabular-nums">
          <span className="sr-only">{temperature} degrees Celsius</span>
          <span aria-hidden="true">{temperature}°</span>
        </p>
        <p className="mt-1 flex items-center justify-center gap-1.5 text-xl font-normal">
          <span aria-hidden="true" className="shrink-0">
            <WeatherIcon
              icon={isDay ? info.icon : nightIcon(info.icon)}
              size={20}
            />
          </span>
          <span>{info.label}</span>
        </p>
        {highLow && (
          <p className="mt-1 flex flex-wrap justify-center gap-x-3 text-[1.0625rem] font-medium tabular-nums text-[var(--sky-fg-dim)]">
            {highLow.map((part) => (
              <span key={part}>{part}</span>
            ))}
          </p>
        )}
        {activityLine && (
          <p className="mt-3 flex items-center justify-center gap-2 text-base font-medium">
            <span
              aria-hidden="true"
              className={`size-2.5 shrink-0 rounded-full ring-2 ring-current ${activityLine.dot}`}
            />
            <span>
              {activityLine.label}: {activityLine.clause}
            </span>
          </p>
        )}
      </div>
    </section>
  );
}
