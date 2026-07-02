"use client";

import { useState, useEffect } from "react";
import styles from "./MukokoWeatherEmbed.module.css";

/** The four supported embed variants. */
export type EmbedType = "current" | "today" | "5day" | "7day";

interface MukokoWeatherEmbedProps {
  /**
   * Widget variant:
   * - `current` — compact current temp + condition + icon
   * - `today`   — fuller current-day card (temp, condition, feels-like, high/low)
   * - `5day`    — 5-day forecast strip
   * - `7day`    — 7-day forecast strip
   */
  type?: EmbedType;
  /**
   * Optional location slug (e.g. "harare"). When omitted, the widget shows the
   * VISITOR's local weather via the IP-based public embed API.
   */
  location?: string;
  /** Optional explicit coordinates (override slug + IP detection). */
  lat?: number;
  lon?: number;
  /** Theme override */
  theme?: "light" | "dark" | "auto";
  /** Base URL of the mukoko weather deployment (defaults to weather.mukoko.com) */
  apiUrl?: string;
  /** Additional CSS class */
  className?: string;
}

interface EmbedData {
  location: { name: string; province: string; slug: string; country: string };
  current: {
    temp: number | null;
    feelsLike: number | null;
    code: number;
    condition: string;
    high: number | null;
    low: number | null;
    humidity: number | null;
    windSpeed: number | null;
    windDirection: string | null;
    isDay: boolean;
  };
  daily: Array<{
    date: string;
    day: string;
    code: number;
    condition: string;
    high: number | null;
    low: number | null;
    precipitationProbability: number | null;
  }>;
  attribution: { name: string; url: string };
}

/** WMO 4677 weather-code → emoji glyph (self-contained icon, no assets). */
function weatherEmoji(code: number, isDay = true): string {
  if (code === 0 || code === 1) return isDay ? "☀️" : "🌙";
  if (code === 2) return isDay ? "⛅" : "☁️";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if (code >= 51 && code <= 57) return "🌦️";
  if (code >= 61 && code <= 67) return "🌧️";
  if (code >= 71 && code <= 77) return "❄️";
  if (code >= 80 && code <= 82) return "🌧️";
  if (code >= 85 && code <= 86) return "🌨️";
  if (code >= 95) return "⛈️";
  return "🌡️";
}

function temp(n: number | null): string {
  return n === null ? "--" : `${n}°`;
}

export function MukokoWeatherEmbed({
  type = "current",
  location,
  lat,
  lon,
  theme = "auto",
  apiUrl = "https://weather.mukoko.com",
  className = "",
}: MukokoWeatherEmbedProps) {
  const [data, setData] = useState<EmbedData | null>(null);
  const [error, setError] = useState(false);

  const isDark =
    theme === "dark" ||
    (theme === "auto" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  const themeClass = isDark ? `${styles.widget} ${styles.widgetDark}` : styles.widget;

  useEffect(() => {
    const qs = new URLSearchParams();
    if (typeof lat === "number" && typeof lon === "number") {
      qs.set("lat", String(lat));
      qs.set("lon", String(lon));
    } else if (location) {
      qs.set("slug", location);
    }
    const query = qs.toString();
    let cancelled = false;
    fetch(`${apiUrl}/api/embed/current${query ? `?${query}` : ""}`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d) => {
        if (!cancelled) setData(d as EmbedData);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [location, lat, lon, apiUrl]);

  if (error) {
    return (
      <div className={`${themeClass} ${className}`}>
        <div className={styles.errorMessage}>
          Weather unavailable —{" "}
          <a
            href={location ? `${apiUrl}/${location}` : apiUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.errorLink}
          >
            view on mukoko weather
          </a>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className={`${themeClass} ${className}`}>
        <div className={styles.stateMessage}>Loading weather...</div>
      </div>
    );
  }

  if (type === "today") {
    return <TodayCard data={data} themeClass={themeClass} className={className} />;
  }
  if (type === "5day") {
    return <ForecastCard data={data} days={5} themeClass={themeClass} className={className} />;
  }
  if (type === "7day") {
    return <ForecastCard data={data} days={7} themeClass={themeClass} className={className} />;
  }
  return <CurrentCondition data={data} themeClass={themeClass} className={className} />;
}

function Attribution({ data }: { data: EmbedData }) {
  return (
    <a
      href={data.attribution.url}
      target="_blank"
      rel="noopener noreferrer"
      className={styles.attribution}
    >
      {data.attribution.name}
    </a>
  );
}

/** current condition — compact current temp + condition + icon */
function CurrentCondition({
  data,
  themeClass,
  className,
}: {
  data: EmbedData;
  themeClass: string;
  className: string;
}) {
  const c = data.current;
  return (
    <div className={`${themeClass} ${className}`}>
      <div className={styles.currentCard}>
        <span className={styles.currentIcon} aria-hidden="true">
          {weatherEmoji(c.code, c.isDay)}
        </span>
        <div className={styles.currentBody}>
          <span className={styles.currentTemp}>{temp(c.temp)}</span>
          <span className={styles.currentMeta}>
            <span className={styles.currentCondition}>{c.condition}</span>
            <span className={styles.currentLocationName}>{data.location.name}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

/** today card — temp, condition, feels-like, high/low */
function TodayCard({
  data,
  themeClass,
  className,
}: {
  data: EmbedData;
  themeClass: string;
  className: string;
}) {
  const c = data.current;
  return (
    <div className={`${themeClass} ${className}`}>
      <div className={styles.todayCard}>
        <div className={styles.todayHeader}>
          <span className={styles.todayLocationName}>{data.location.name}</span>
          {data.location.province && (
            <span className={styles.todayProvince}>{data.location.province}</span>
          )}
        </div>
        <div className={styles.todayBody}>
          <span className={styles.todayIcon} aria-hidden="true">
            {weatherEmoji(c.code, c.isDay)}
          </span>
          <div className={styles.todayTempBlock}>
            <span className={styles.todayTemp}>{temp(c.temp)}</span>
            <span className={styles.todayCondition}>{c.condition}</span>
          </div>
        </div>
        <div className={styles.todayStats}>
          <span>Feels like {temp(c.feelsLike)}</span>
          <span>
            H {temp(c.high)} · L {temp(c.low)}
          </span>
        </div>
        <Attribution data={data} />
      </div>
    </div>
  );
}

/** 5-day / 7-day forecast strip */
function ForecastCard({
  data,
  days,
  themeClass,
  className,
}: {
  data: EmbedData;
  days: number;
  themeClass: string;
  className: string;
}) {
  const n = Math.min(days, data.daily.length);
  return (
    <div className={`${themeClass} ${className}`}>
      <div className={styles.forecastCard}>
        <div className={styles.forecastTitle}>{data.location.name} · {days}-day forecast</div>
        {data.daily.slice(0, n).map((d, i) => (
          <div
            key={d.date}
            className={i < n - 1 ? styles.forecastRowBorder : styles.forecastRow}
          >
            <span className={styles.forecastDay}>{d.day}</span>
            <span className={styles.forecastIcon} aria-hidden="true">
              {weatherEmoji(d.code)}
            </span>
            <span className={styles.forecastCondition}>{d.condition}</span>
            <span className={styles.forecastTemps}>
              {temp(d.high)} / {temp(d.low)}
            </span>
          </div>
        ))}
        <Attribution data={data} />
      </div>
    </div>
  );
}
