"use client";

import { useState, useEffect } from "react";
import styles from "./MukokoWeatherEmbed.module.css";

interface MukokoWeatherEmbedProps {
  /** Location slug (e.g. "harare", "bulawayo", "marondera") */
  location: string;
  /** Widget type */
  type?: "current" | "forecast" | "badge";
  /** Number of forecast days (for type="forecast") */
  days?: number;
  /** Theme override */
  theme?: "light" | "dark" | "auto";
  /** Base API URL (defaults to weather.nyuchi.com) */
  apiUrl?: string;
  /** Additional CSS class */
  className?: string;
}

interface WeatherData {
  location: {
    name: string;
    slug: string;
    province: string;
    elevation: number;
    tags: string[];
  };
  weather: {
    current: {
      temperature_2m: number;
      relative_humidity_2m: number;
      apparent_temperature: number;
      weather_code: number;
      wind_speed_10m: number;
      wind_direction_10m: number;
      uv_index: number;
      is_day: number;
    };
    daily: {
      time: string[];
      weather_code: number[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      precipitation_probability_max: number[];
    };
  };
  _meta: { url: string };
}

function weatherLabel(code: number): string {
  const map: Record<number, string> = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Fog", 51: "Drizzle", 53: "Drizzle", 55: "Drizzle",
    61: "Rain", 63: "Rain", 65: "Heavy rain", 80: "Showers", 81: "Showers",
    95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm",
  };
  return map[code] ?? "Unknown";
}

function windDir(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

export function MukokoWeatherEmbed({
  location,
  type = "current",
  days = 5,
  theme = "auto",
  apiUrl = "https://weather.nyuchi.com",
  className = "",
}: MukokoWeatherEmbedProps) {
  const [data, setData] = useState<WeatherData | null>(null);
  const [error, setError] = useState(false);

  const isDark =
    theme === "dark" ||
    (theme === "auto" && typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  const themeClass = isDark ? `${styles.widget} ${styles.widgetDark}` : styles.widget;

  useEffect(() => {
    fetch(`${apiUrl}/embed/data/${encodeURIComponent(location)}`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d) => setData(d as WeatherData))
      .catch(() => setError(true));
  }, [location, apiUrl]);

  if (error) {
    return (
      <div className={`${themeClass} ${className}`}>
        <div className={styles.errorMessage}>
          Weather unavailable —{" "}
          <a href={`${apiUrl}/${location}`} target="_blank" rel="noopener noreferrer" className={styles.errorLink}>
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

  if (type === "badge") {
    return <BadgeWidget data={data} themeClass={themeClass} className={className} />;
  }

  if (type === "forecast") {
    return <ForecastWidget data={data} days={days} themeClass={themeClass} className={className} />;
  }

  return <CurrentWidget data={data} themeClass={themeClass} className={className} />;
}

function CurrentWidget({ data, themeClass, className }: { data: WeatherData; themeClass: string; className: string }) {
  const c = data.weather.current;
  return (
    <div className={`${themeClass} ${className}`}>
      <div className={styles.currentCard}>
        <div className={styles.currentHeader}>
          <span className={styles.currentLocationName}>{data.location.name}</span>
          <span className={styles.currentProvince}>{data.location.province}</span>
        </div>
        <div className={styles.currentBody}>
          <span className={styles.currentTemp}>
            {Math.round(c.temperature_2m)}°C
          </span>
          <span className={styles.currentCondition}>{weatherLabel(c.weather_code)}</span>
          <span className={styles.currentFeelsLike}>Feels like {Math.round(c.apparent_temperature)}°C</span>
        </div>
        <div className={styles.currentStats}>
          <span>Humidity {c.relative_humidity_2m}%</span>
          <span>Wind {Math.round(c.wind_speed_10m)} km/h {windDir(c.wind_direction_10m)}</span>
          <span>UV {c.uv_index}</span>
        </div>
        <a href={data._meta.url} target="_blank" rel="noopener noreferrer" className={styles.attribution}>
          mukoko weather
        </a>
      </div>
    </div>
  );
}

function ForecastWidget({ data, days, themeClass, className }: { data: WeatherData; days: number; themeClass: string; className: string }) {
  const d = data.weather.daily;
  const n = Math.min(days, d.time.length);
  return (
    <div className={`${themeClass} ${className}`}>
      <div className={styles.forecastCard}>
        <div className={styles.forecastTitle}>
          {data.location.name} Forecast
        </div>
        {Array.from({ length: n }).map((_, i) => {
          const date = new Date(d.time[i]);
          const dayName = i === 0 ? "Today" : date.toLocaleDateString("en-ZW", { weekday: "short" });
          return (
            <div key={d.time[i]} className={i < n - 1 ? styles.forecastRowBorder : styles.forecastRow}>
              <span className={styles.forecastDay}>{dayName}</span>
              <span className={styles.forecastCondition}>{weatherLabel(d.weather_code[i])}</span>
              <span className={styles.forecastTemps}>
                {Math.round(d.temperature_2m_max[i])}° / {Math.round(d.temperature_2m_min[i])}°
              </span>
            </div>
          );
        })}
        <a href={data._meta.url} target="_blank" rel="noopener noreferrer" className={styles.attribution}>
          mukoko weather
        </a>
      </div>
    </div>
  );
}

function BadgeWidget({ data, themeClass, className }: { data: WeatherData; themeClass: string; className: string }) {
  const c = data.weather.current;
  return (
    <div className={`${themeClass} ${className}`}>
      <a href={data._meta.url} target="_blank" rel="noopener noreferrer" className={styles.badge}>
        <span className={styles.badgeTemp}>{Math.round(c.temperature_2m)}°C</span>
        <span className={styles.badgeCondition}>{weatherLabel(c.weather_code)}</span>
        <span className={styles.badgeLocation}>{data.location.name}</span>
        <span className={styles.badgeBrand}>mukoko</span>
      </a>
    </div>
  );
}
