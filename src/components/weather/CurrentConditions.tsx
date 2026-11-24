"use client";

import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import Link from "next/link";
import { MukokoLogo } from "@/components/brand/MukokoLogo";
import { useRegisterSkyHero } from "@/lib/sky-hero";
import { NavigationIcon, WeatherIcon, nightIcon } from "@/lib/weather-icons";
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
  formatFeelsLike,
  formatHighLowParts,
  heroActivityClause,
  heroLocalTime,
  heroBadgeLabel,
  heroEyebrowBadges,
  heroOutlook,
  isHomeLocation,
  skyFamily,
  type HeroBadge,
} from "@/lib/hero";
import { HeroDataCard, type HeroActivityLine } from "./HeroDataCard";

interface Props {
  current: CurrentWeather;
  locationName: string;
  /** The country's name, under the place name. Left out when not known. */
  countryName?: string;
  daily?: DailyWeather;
  /** Hourly forecast — powers the one-sentence outlook, the data card's hours
   *  and curve, and the activity clause. */
  hourly?: HourlyWeather;
  /** The location's UTC offset (payload `utc_offset_seconds`) — the outlook
   *  and activity clause read "now" and hour labels in the PLACE's time. */
  utcOffsetSeconds?: number;
  slug?: string;
  /** GPS-confirmed current location (silent-URL home) — shows the
   *  MY LOCATION eyebrow above the location name. */
  isCurrentLocation?: boolean;
  /**
   * Alerts for this place (frost, the weather being unavailable): banners a
   * person can close, drawn under the top row and above the place's name, never
   * under the Quick actions group at the top right.
   */
  notices?: ReactNode;
  /**
   * What the page owes its sources, quiet, under the data card: the licence
   * and data credits and the line that says how old the data is. These are not
   * closable: a licence notice has to stay on the page.
   */
  sources?: ReactNode;
  /**
   * The breadcrumb trail: one quiet line under the data card (the hero already
   * says where you are, so the trail is for going up, not for orientation).
   */
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
  countryName,
  daily,
  hourly,
  utcOffsetSeconds,
  slug,
  isCurrentLocation = false,
  notices,
  sources,
  breadcrumb,
}: Props) {
  const info = weatherCodeToInfo(current.weather_code);
  const isDay = current.is_day === 1;
  const family = skyFamily(current.weather_code, isDay);
  const temperature = Math.round(current.temperature_2m);
  // Guard empty daily arrays — the formatters return null instead of "H:NaN°"
  // or "Feels NaN°"; each part is left out on its own.
  const highLow = formatHighLowParts(
    daily?.temperature_2m_max?.[0],
    daily?.temperature_2m_min?.[0],
  );
  const detailParts = [
    ...(highLow ?? []),
    formatFeelsLike(current.apparent_temperature),
  ].filter((part): part is string => part !== null);
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
  const activityLine = useMemo((): HeroActivityLine | null => {
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

  // The one plain sentence about the day ahead (deterministic, no AI call),
  // read in the PLACE's time, so it waits for the client clock. While it
  // waits, two lines are held for it so the card below does not move when it
  // arrives; a place with no hourly forecast holds nothing.
  const outlook = useMemo(
    () => (now && hourly ? heroOutlook(hourly, now, utcOffsetSeconds) : null),
    [now, hourly, utcOffsetSeconds],
  );
  const holdOutlook = now === null && Boolean(hourly?.time?.length);

  // Tell the Quick actions group (mounted once, in the layout) where this
  // hero's first line of content is and which place it shows: the group is
  // clear while only bare sky is behind it (until that line scrolls up to it),
  // and its Share names this place.
  const contentRef = useRef<HTMLParagraphElement>(null);
  useRegisterSkyHero(contentRef, { name: locationName, slug });

  return (
    <div className="pr-[env(safe-area-inset-right,0px)] pl-[env(safe-area-inset-left,0px)]">
      {/* The open sky: the page backdrop is the sky, so this part is bare
          text on it, never a card. Every row has its own line: the place name
          is not pulled up over the eyebrow, and the glyph has its own column.
          Nothing here uses a negative margin or a transform. */}
      <section
        aria-labelledby="current-conditions-heading"
        data-sky-hero
        data-sky={family}
        className="relative text-[var(--sky-fg)]"
      >
        {/* Top row, phones only: the mukoko mark at the left and nothing else
            (owner, 2026-11-23: the hero says where you are, so no words
            here). The phone header is not drawn over a sky hero, so the mark
            lives here; from `sm` the site header carries it and this row is
            not drawn. The Quick actions group (Share, Notifications,
            Locations: the same on every page, owner 2026-11-11) is not drawn
            here either: the layout mounts it once, fixed to the top right of
            the screen, clear over this sky and solid after the page scrolls
            past it (see QuickActions). The row is as tall as the group's
            controls (49px), so what follows it is always below the group. */}
        <div className="flex min-h-[var(--touch-target-min)] items-center justify-between gap-3 pt-1 sm:hidden">
          <Link
            href="/"
            prefetch={false}
            aria-label="mukoko weather — return to home page"
            className="flex min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)] items-center"
          >
            <MukokoLogo wordmarkClassName="hidden" />
          </Link>
        </div>
        {/* Alerts: under the top row, never under the group, each one a
            banner that can be closed. Nothing is drawn (no gap) without one. */}
        {notices && <div className="space-y-3 pt-2">{notices}</div>}
        <div className="pt-4 pb-[26px]">
          {/* Identity: the eyebrow, the name and the country each on their own
              row at the left, the weather glyph in its own column at the right
              spanning them. */}
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 min-[360px]:gap-x-3">
            {/* Eyebrow: MY LOCATION / HOME, else the place's own clock. The
                line is always reserved so the clock arriving after mount
                never shifts the page. It is the hero's first line of content,
                the one the Quick actions group watches (the block's own
                padding above it is bare sky, so the block's edge is not the
                line's). */}
            <p
              ref={contentRef}
              className="col-start-1 row-start-1 flex min-h-[calc(var(--text-caption)*var(--text-caption-leading))] flex-wrap items-center gap-x-2 font-mono text-[length:var(--text-caption)] leading-[var(--text-caption-leading)] font-semibold uppercase tracking-widest text-[var(--sky-fg-dim)]"
            >
              {badges.length > 0
                ? badges.map((badge, i) => (
                    <span
                      key={badge}
                      className="inline-flex items-center gap-2"
                    >
                      {i > 0 && <span aria-hidden="true">·</span>}
                      <EyebrowBadge badge={badge} />
                    </span>
                  ))
                : localTime}
            </p>
            <h2
              id="current-conditions-heading"
              className="col-start-1 row-start-2 font-heading text-[length:var(--text-h2)] leading-[var(--text-h2-leading)] font-semibold break-words hyphens-auto max-[359px]:text-[length:var(--text-h3)] max-[359px]:leading-[var(--text-h3-leading)]"
            >
              {locationName}
            </h2>
            {countryName && (
              <p className="col-start-1 row-start-3 text-[length:var(--text-body-sm)] leading-[var(--text-body-sm-leading)] text-[var(--sky-fg-dim)]">
                {countryName}
              </p>
            )}
            <span
              aria-hidden="true"
              className="col-start-2 row-span-3 row-start-1 self-center block size-10 min-[360px]:size-14"
            >
              <WeatherIcon
                icon={isDay ? info.icon : nightIcon(info.icon)}
                size={56}
                className="size-full"
              />
            </span>
          </div>
          <p className="mt-3 max-w-full font-sans text-[length:var(--text-display)] leading-[var(--text-display-leading)] font-normal tracking-tight tabular-nums">
            <span className="sr-only">{temperature} degrees Celsius</span>
            <span aria-hidden="true">{temperature}°</span>
          </p>
          <p className="mt-1 text-[length:var(--text-h5)] leading-[var(--text-h5-leading)] font-semibold">
            {info.label}
          </p>
          {detailParts.length > 0 && (
            <p className="mt-1 flex flex-wrap gap-x-3 text-[length:var(--text-body-lg)] leading-[var(--text-body-lg-leading)] font-semibold tabular-nums text-[var(--sky-fg-dim)]">
              {detailParts.map((part) => (
                <span key={part}>{part}</span>
              ))}
            </p>
          )}
          {(outlook || holdOutlook) && (
            <p
              className={`mt-3 max-w-[40ch] text-pretty text-[length:var(--text-body)] leading-[var(--text-body-leading)] ${
                holdOutlook
                  ? "min-h-[calc(2*var(--text-body)*var(--text-body-leading))]"
                  : ""
              }`}
            >
              {outlook}
            </p>
          )}
        </div>
      </section>
      {/* The one data card: everything you scan or tap, on a real surface.
          It is a sibling of the sky section, not a child: the sky section
          points the focus ring and the text at white, which a card must not
          inherit. */}
      <HeroDataCard
        current={current}
        placeName={locationName}
        hourly={hourly}
        utcOffsetSeconds={utcOffsetSeconds}
        now={now}
        hasSelection={hasSelection}
        activityLine={activityLine}
      />
      {/* Under the card: the sources (licence and data credits, how old the
          data is), then the breadcrumb, each one quiet line or short block.
          The sky is still behind them (the Conditions card under this is the
          translucent sky card), so they take the sky ink, as the hero's own
          text does. A sibling of the sky section, like the card. */}
      {(sources || breadcrumb) && (
        <div className="kestrel-ink mt-4 space-y-3 text-[length:var(--text-caption)] leading-[var(--text-caption-leading)] text-[var(--sky-fg-dim)]">
          {sources}
          {breadcrumb}
        </div>
      )}
    </div>
  );
}
