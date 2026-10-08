"use client";

import dynamic from "next/dynamic";
import { useEffect, useState, type ReactNode } from "react";
import { SunriseIcon, SunsetIcon, WeatherIcon } from "@/lib/weather-icons";
import { psiBandInfo, sgRegionLabel, type SgAirResponse } from "@/lib/sg-air";
import { hourlySummary } from "@/lib/hourly-summary";
import {
  weatherCodeToInfo,
  windDirection,
  uvLevel,
  type WeatherData,
} from "@/lib/weather";
import { formatDayName, formatTemp, formatTime } from "@/lib/i18n";
import { locationClockLabel, weatherOffsetSeconds } from "@/lib/location-time";
import { useHydrated } from "@/lib/use-hydrated";
import {
  AQI_ADVICE,
  AQI_TEXT_CLASS,
  currentHourIndex,
  nextHourIndexes,
} from "@/lib/display";
import {
  AQI_LEVEL_LABELS,
  POLLUTANT_LABELS,
  formatPollutant,
  type AirQualityResponse,
} from "@/components/weather/AirQualityCard";
import { MapSkeleton } from "@/components/weather/map/MapSkeleton";
import { getMapLayerById } from "@/lib/map-layers";
import { cn } from "@/lib/utils";

const MapLibreMap = dynamic(
  () =>
    import("@/components/weather/map/MapLibreMap").then((m) => ({
      default: m.MapLibreMap,
    })),
  { ssr: false, loading: () => <MapSkeleton fill /> },
);

/* ── Clock ─────────────────────────────────────────────────────────────── */

/**
 * Live clock and date. Hydration-gated: the server can't know the viewer's
 * wall clock, so both server and first client render show a placeholder.
 */
export function DisplayClock({ locationName }: { locationName: string }) {
  const hydrated = useHydrated();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <header className="flex items-end justify-between gap-4" role="banner">
      <div className="min-w-0">
        <p className="font-mono text-sm uppercase tracking-widest text-text-tertiary">
          mukoko weather
        </p>
        <h1 className="truncate font-heading text-3xl font-bold text-text-primary lg:text-4xl">
          {locationName}
        </h1>
      </div>
      <div className="text-right" aria-live="off">
        <p className="font-mono text-4xl font-semibold tabular-nums text-text-primary lg:text-5xl">
          {hydrated ? formatTime(now) : "--:--"}
        </p>
        <p className="text-base text-text-secondary">
          {hydrated
            ? new Intl.DateTimeFormat("en-ZW", {
                weekday: "long",
                day: "numeric",
                month: "long",
              }).format(now)
            : " "}
        </p>
      </div>
    </header>
  );
}

/* ── Current conditions ────────────────────────────────────────────────── */

export function DisplayNow({ weather }: { weather: WeatherData }) {
  const c = weather.current;
  const info = weatherCodeToInfo(c.weather_code);
  const high = weather.daily.temperature_2m_max[0];
  const low = weather.daily.temperature_2m_min[0];
  const uv = uvLevel(c.uv_index);

  return (
    <section aria-labelledby="display-now-heading" className="baobab p-5">
      <h2 id="display-now-heading" className="sr-only">
        Current conditions
      </h2>
      <div className="flex items-center gap-5">
        <span aria-hidden="true" className="shrink-0">
          <WeatherIcon
            icon={info.icon}
            size={96}
            className="shrink-0 text-primary"
          />
        </span>
        <div className="min-w-0">
          <p className="font-heading text-7xl font-bold leading-none tabular-nums text-text-primary">
            {formatTemp(c.temperature_2m)}
          </p>
          <p className="mt-1 text-2xl text-text-primary">{info.label}</p>
          <p className="text-lg text-text-secondary">
            Feels like {formatTemp(c.apparent_temperature)}
            {Number.isFinite(high) && Number.isFinite(low) && (
              <>
                {" · "}H {formatTemp(high)} L {formatTemp(low)}
              </>
            )}
          </p>
        </div>
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-3 text-lg sm:grid-cols-4">
        <Stat
          label="Humidity"
          value={`${Math.round(c.relative_humidity_2m)}%`}
        />
        <Stat
          label="Wind"
          value={`${Math.round(c.wind_speed_10m)} km/h ${windDirection(c.wind_direction_10m)}`}
        />
        <Stat label="UV" value={`${Math.round(c.uv_index)} ${uv.label}`} />
        <Stat
          label="Rain today"
          value={`${weather.daily.precipitation_probability_max[0] ?? 0}%`}
        />
      </dl>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm uppercase tracking-wide text-text-tertiary">
        {label}
      </dt>
      <dd className="font-semibold tabular-nums text-text-primary">{value}</dd>
    </div>
  );
}

/* ── Air quality ───────────────────────────────────────────────────────── */

export function DisplayAirQuality({
  air,
  children,
}: {
  air: AirQualityResponse | null;
  /** Optional extra readings shown inside this card (e.g. the NEA panel). */
  children?: ReactNode;
}) {
  if (!air) {
    return (
      <section aria-labelledby="display-aq-heading" className="acacia p-5">
        <h2 id="display-aq-heading" className="giraffe">
          Air quality
        </h2>
        <p className="mt-2 text-lg text-text-secondary">
          Air quality is unavailable right now. It will refresh on its own.
        </p>
        {children}
      </section>
    );
  }

  const label = AQI_LEVEL_LABELS[air.level] ?? air.level;
  const pm25 = air.pollutants?.pm2_5;
  const dominant = air.dominantPollutant
    ? POLLUTANT_LABELS[air.dominantPollutant]
    : null;

  return (
    <section aria-labelledby="display-aq-heading" className="acacia p-5">
      <h2 id="display-aq-heading" className="giraffe">
        Air quality
      </h2>
      <div className="mt-2 flex items-baseline gap-4">
        <p
          className={cn(
            "font-heading text-6xl font-bold tabular-nums",
            AQI_TEXT_CLASS[air.level],
          )}
        >
          {air.aqi}
        </p>
        <div>
          <p
            className={cn("text-2xl font-semibold", AQI_TEXT_CLASS[air.level])}
          >
            {label}
          </p>
          <p className="text-base text-text-secondary">
            US AQI
            {dominant ? ` · mostly ${dominant}` : ""}
            {pm25 !== null && pm25 !== undefined
              ? ` · PM2.5 ${formatPollutant(pm25)}`
              : ""}
          </p>
        </div>
      </div>
      <p className="mt-3 text-lg leading-snug text-text-primary">
        {AQI_ADVICE[air.level]}
      </p>
      {children}
    </section>
  );
}

/**
 * The official Singapore NEA reading, shown beneath the modelled US AQI inside
 * the air-quality card. Singapore haze is reported in PSI, the number residents
 * read, so it sits alongside the model rather than replacing it.
 */
export function DisplaySgPsi({
  sg,
  loading,
}: {
  sg: SgAirResponse | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div
        className="chameleon mt-4 h-16"
        role="status"
        aria-label="Loading official NEA reading"
      />
    );
  }

  if (!sg || !sg.available || sg.psi24h === null) {
    return (
      <div className="mt-4 border-t border-border pt-3">
        <p className="text-base text-text-secondary">
          Official NEA reading is unavailable right now.
        </p>
      </div>
    );
  }

  const band = psiBandInfo(sg.psi24h);
  const region = sg.nearestRegion ? sgRegionLabel(sg.nearestRegion) : null;
  const pm25 = sg.pm25OneHour;

  return (
    <div className="mt-4 border-t border-border pt-3">
      <p className="text-sm font-semibold uppercase tracking-wide text-text-tertiary">
        Official · NEA Singapore
      </p>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="text-xl text-text-primary">
          PSI (24h){" "}
          <span
            className={cn(
              "font-heading text-4xl font-bold tabular-nums",
              band.textClass,
            )}
          >
            {sg.psi24h}
          </span>
        </p>
        <p className={cn("text-2xl font-semibold", band.textClass)}>
          {band.label}
        </p>
      </div>
      <p className="mt-1 text-base text-text-secondary">
        {sg.psiBasis === "highest_region" ? "Highest region" : "National"}
        {region && sg.psiBasis === "highest_region" ? `: ${region}` : ""}
        {pm25 !== null ? ` · PM2.5 (1h) ${pm25} µg/m³` : ""}
        {sg.observedAt && (
          <>
            {" · Updated "}
            <time dateTime={sg.observedAt}>
              {formatTime(new Date(sg.observedAt))}
            </time>
          </>
        )}
      </p>
      <p className="text-sm text-text-tertiary">{sg.source}</p>
    </div>
  );
}

/* ── Radar map ─────────────────────────────────────────────────────────── */

export function DisplayRadar({
  lat,
  lon,
  layer,
}: {
  lat: number;
  lon: number;
  layer: string;
}) {
  const meta = getMapLayerById(layer);
  return (
    <section
      aria-labelledby="display-map-heading"
      className="relative h-full min-h-[18rem] overflow-hidden lg:min-h-0 rounded-[var(--radius-card)] border border-border"
    >
      <h2 id="display-map-heading" className="sr-only">
        {meta?.description ?? "Weather map"} around this location
      </h2>
      <MapLibreMap
        lat={lat}
        lon={lon}
        zoom={7}
        interactive={false}
        weatherLayer={layer}
        className="h-full w-full"
      />
      {meta && (
        <span
          className={cn(
            "pointer-events-none absolute left-3 top-3 rounded-[var(--radius-button)] px-3 py-1 text-sm font-semibold",
            meta.style.badge,
          )}
        >
          {meta.label}
        </span>
      )}
    </section>
  );
}

/* ── Hourly + daily ────────────────────────────────────────────────────── */

export function DisplayHours({ weather }: { weather: WeatherData }) {
  const hydrated = useHydrated();
  const h = weather.hourly;
  const offset = weatherOffsetSeconds(weather);
  // Every 2 hours for the next 16 — eight readable cells across a TV.
  const idxs = hydrated
    ? nextHourIndexes(h.time, new Date(), 8, 2, weather.utc_offset_seconds)
    : [];

  return (
    <section aria-labelledby="display-hours-heading" className="acacia p-4">
      <h2 id="display-hours-heading" className="giraffe mb-2">
        Next hours
      </h2>
      <ol className="grid grid-cols-4 gap-2 sm:grid-cols-8">
        {idxs.map((i, n) => {
          const info = weatherCodeToInfo(h.weather_code[i]);
          return (
            <li key={h.time[i]} className="flex flex-col items-center gap-1">
              <span className="text-sm text-text-secondary">
                {n === 0 ? "Now" : locationClockLabel(h.time[i], offset)}
              </span>
              <span aria-hidden="true" className="shrink-0">
                <WeatherIcon icon={info.icon} size={32} />
              </span>
              <span className="sr-only">{info.label}</span>
              <span className="text-lg font-semibold tabular-nums text-text-primary">
                {formatTemp(h.temperature_2m[i])}
              </span>
              <span className="text-sm tabular-nums text-mineral-cobalt">
                {Math.round(h.precipitation_probability[i] ?? 0)}%
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function DisplayDays({ weather }: { weather: WeatherData }) {
  const d = weather.daily;
  const days = d.time.slice(0, 5);
  return (
    <section aria-labelledby="display-days-heading" className="acacia p-4">
      <h2 id="display-days-heading" className="giraffe mb-2">
        Next 5 days
      </h2>
      <ol className="grid grid-cols-5 gap-2">
        {days.map((t, i) => {
          const info = weatherCodeToInfo(d.weather_code[i]);
          return (
            <li key={t} className="flex flex-col items-center gap-1">
              <span className="text-base font-medium text-text-secondary">
                {i === 0 ? "Today" : formatDayName(new Date(`${t}T12:00:00`))}
              </span>
              <span aria-hidden="true" className="shrink-0">
                <WeatherIcon icon={info.icon} size={36} />
              </span>
              <span className="sr-only">{info.label}</span>
              <span className="text-lg font-semibold tabular-nums text-text-primary">
                {formatTemp(d.temperature_2m_max[i])}
              </span>
              <span className="text-base tabular-nums text-text-tertiary">
                {formatTemp(d.temperature_2m_min[i])}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* ── Today's outlook ───────────────────────────────────────────────────── */

/**
 * One deterministic sentence about the next hours (the same Apple-style
 * summary the location page uses, no AI call) plus sunrise and sunset.
 */
export function DisplayOutlook({ weather }: { weather: WeatherData }) {
  const hydrated = useHydrated();
  const summary = hydrated
    ? hourlySummary(
        weather.hourly,
        currentHourIndex(
          weather.hourly.time,
          new Date(),
          weather.utc_offset_seconds,
        ),
        weather.utc_offset_seconds,
      )
    : null;
  const sunrise = weather.daily.sunrise?.[0];
  const sunset = weather.daily.sunset?.[0];

  return (
    <section
      aria-labelledby="display-outlook-heading"
      className="acacia flex flex-col justify-between gap-4 p-5"
    >
      <div>
        <h2 id="display-outlook-heading" className="giraffe">
          Today
        </h2>
        <p className="mt-2 text-xl leading-snug text-text-primary">
          {summary ?? " "}
        </p>
      </div>
      {(sunrise || sunset) && (
        <dl className="flex gap-8 text-lg">
          {sunrise && (
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="text-mineral-gold">
                <SunriseIcon size={28} />
              </span>
              <dt className="sr-only">Sunrise</dt>
              <dd className="font-semibold tabular-nums text-text-primary">
                {locationClockLabel(sunrise, weatherOffsetSeconds(weather))}
              </dd>
            </div>
          )}
          {sunset && (
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="text-mineral-terracotta">
                <SunsetIcon size={28} />
              </span>
              <dt className="sr-only">Sunset</dt>
              <dd className="font-semibold tabular-nums text-text-primary">
                {locationClockLabel(sunset, weatherOffsetSeconds(weather))}
              </dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}
