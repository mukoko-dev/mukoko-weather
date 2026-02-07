"use client";

import { useState, useEffect } from "react";

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

  useEffect(() => {
    fetch(`${apiUrl}/embed/data/${encodeURIComponent(location)}`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d) => setData(d as WeatherData))
      .catch(() => setError(true));
  }, [location, apiUrl]);

  const vars = {
    "--mkw-bg": isDark ? "#141414" : "#FFFFFF",
    "--mkw-bg-subtle": isDark ? "#1E1E1E" : "#FAF9F5",
    "--mkw-text": isDark ? "#F5F5F4" : "#141413",
    "--mkw-text-secondary": isDark ? "#A8A8A3" : "#52524E",
    "--mkw-text-tertiary": isDark ? "#6B6B66" : "#8C8B87",
    "--mkw-primary": isDark ? "#B388FF" : "#4B0082",
    "--mkw-border": isDark ? "rgba(107,107,102,0.2)" : "rgba(140,139,135,0.15)",
  } as React.CSSProperties;

  if (error) {
    return (
      <div className={className} style={vars}>
        <div style={{ padding: "16px", textAlign: "center", color: "var(--mkw-text-secondary)", fontSize: "13px" }}>
          Weather unavailable —{" "}
          <a href={`${apiUrl}/${location}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--mkw-primary)" }}>
            view on mukoko weather
          </a>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className={className} style={vars}>
        <div style={{ padding: "20px", textAlign: "center", color: "var(--mkw-text-tertiary)", fontSize: "13px" }}>
          Loading weather...
        </div>
      </div>
    );
  }

  if (type === "badge") {
    return <BadgeWidget data={data} isDark={isDark} className={className} vars={vars} />;
  }

  if (type === "forecast") {
    return <ForecastWidget data={data} days={days} className={className} vars={vars} />;
  }

  return <CurrentWidget data={data} className={className} vars={vars} />;
}

function CurrentWidget({ data, className, vars }: { data: WeatherData; className: string; vars: React.CSSProperties }) {
  const c = data.weather.current;
  return (
    <div className={className} style={vars}>
      <div style={{
        background: "var(--mkw-bg)", border: "1px solid var(--mkw-border)",
        borderRadius: "16px", padding: "20px", maxWidth: "360px",
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "12px" }}>
          <span style={{ fontWeight: 600, fontSize: "14px", color: "var(--mkw-text)" }}>{data.location.name}</span>
          <span style={{ fontSize: "12px", color: "var(--mkw-text-tertiary)" }}>{data.location.province}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "2px", marginBottom: "16px" }}>
          <span style={{ fontSize: "48px", fontWeight: 700, color: "var(--mkw-text)", lineHeight: 1.1, fontFamily: "'Noto Serif', Georgia, serif" }}>
            {Math.round(c.temperature_2m)}°C
          </span>
          <span style={{ fontSize: "16px", fontWeight: 500, color: "var(--mkw-text)" }}>{weatherLabel(c.weather_code)}</span>
          <span style={{ fontSize: "13px", color: "var(--mkw-text-secondary)" }}>Feels like {Math.round(c.apparent_temperature)}°C</span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", paddingTop: "12px", borderTop: "1px solid var(--mkw-border)", fontSize: "12px", color: "var(--mkw-text-secondary)" }}>
          <span>Humidity {c.relative_humidity_2m}%</span>
          <span>Wind {Math.round(c.wind_speed_10m)} km/h {windDir(c.wind_direction_10m)}</span>
          <span>UV {c.uv_index}</span>
        </div>
        <a href={data._meta.url} target="_blank" rel="noopener noreferrer"
          style={{ display: "block", marginTop: "12px", paddingTop: "8px", borderTop: "1px solid var(--mkw-border)", fontSize: "11px", color: "var(--mkw-primary)", textDecoration: "none", fontWeight: 600 }}>
          mukoko weather
        </a>
      </div>
    </div>
  );
}

function ForecastWidget({ data, days, className, vars }: { data: WeatherData; days: number; className: string; vars: React.CSSProperties }) {
  const d = data.weather.daily;
  const n = Math.min(days, d.time.length);
  return (
    <div className={className} style={vars}>
      <div style={{
        background: "var(--mkw-bg)", border: "1px solid var(--mkw-border)",
        borderRadius: "16px", padding: "20px", maxWidth: "440px",
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
      }}>
        <div style={{ fontWeight: 600, fontSize: "14px", color: "var(--mkw-text)", marginBottom: "12px" }}>
          {data.location.name} Forecast
        </div>
        {Array.from({ length: n }).map((_, i) => {
          const date = new Date(d.time[i]);
          const dayName = i === 0 ? "Today" : date.toLocaleDateString("en-ZW", { weekday: "short" });
          return (
            <div key={d.time[i]} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "8px 0", borderBottom: i < n - 1 ? "1px solid var(--mkw-border)" : "none", fontSize: "13px", color: "var(--mkw-text)" }}>
              <span style={{ width: "48px", fontWeight: 500, color: "var(--mkw-text-secondary)" }}>{dayName}</span>
              <span style={{ flex: 1, color: "var(--mkw-text-secondary)" }}>{weatherLabel(d.weather_code[i])}</span>
              <span style={{ fontWeight: 600, fontFamily: "monospace", fontSize: "12px" }}>
                {Math.round(d.temperature_2m_max[i])}° / {Math.round(d.temperature_2m_min[i])}°
              </span>
            </div>
          );
        })}
        <a href={data._meta.url} target="_blank" rel="noopener noreferrer"
          style={{ display: "block", marginTop: "12px", paddingTop: "8px", borderTop: "1px solid var(--mkw-border)", fontSize: "11px", color: "var(--mkw-primary)", textDecoration: "none", fontWeight: 600 }}>
          mukoko weather
        </a>
      </div>
    </div>
  );
}

function BadgeWidget({ data, isDark, className, vars }: { data: WeatherData; isDark: boolean; className: string; vars: React.CSSProperties }) {
  const c = data.weather.current;
  return (
    <div className={className} style={vars}>
      <a href={data._meta.url} target="_blank" rel="noopener noreferrer"
        style={{
          display: "inline-flex", alignItems: "center", gap: "8px", padding: "6px 12px",
          background: isDark ? "#141414" : "#FFFFFF", border: "1px solid var(--mkw-border)",
          borderRadius: "9999px", fontSize: "13px", color: "var(--mkw-text)", textDecoration: "none", whiteSpace: "nowrap",
          fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
        }}>
        <span style={{ fontWeight: 700 }}>{Math.round(c.temperature_2m)}°C</span>
        <span style={{ color: "var(--mkw-text-secondary)" }}>{weatherLabel(c.weather_code)}</span>
        <span style={{ color: "var(--mkw-text-tertiary)", fontSize: "11px" }}>{data.location.name}</span>
        <span style={{ color: "var(--mkw-primary)", fontSize: "10px", fontWeight: 600 }}>mukoko</span>
      </a>
    </div>
  );
}
