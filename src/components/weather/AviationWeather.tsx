"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";

interface CloudLayer {
  cover: string;
  base_ft: number | null;
}

interface MetarObs {
  time: string;
  temp: number | null;
  dewp: number | null;
  wind_dir: number | null;
  wind_speed: number | null;
  wind_variable: boolean;
  visibility: string | null;
  clouds: CloudLayer[];
  weather: string | null;
  pressure_hpa: number | null;
  flight_category: string;
  change: string | null;
  raw: string;
}

interface MetarData {
  icao: string;
  metar: MetarObs[];
  taf: string | null;
  source: string;
}

interface Props {
  slug: string;
  icao: string;
}

const FLIGHT_CATEGORY_STYLES: Record<string, string> = {
  VFR: "bg-severity-low text-white",
  MVFR: "bg-primary text-primary-foreground",
  IFR: "bg-severity-high text-white",
  LIFR: "bg-severity-severe text-white",
};

function formatWind(obs: MetarObs): string {
  if (obs.wind_variable) return `Variable ${obs.wind_speed ?? 0}kt`;
  if (obs.wind_dir === null && obs.wind_speed === null) return "—";
  return `${obs.wind_dir ?? "VRB"}° ${obs.wind_speed ?? 0}kt`;
}

function formatClouds(clouds: CloudLayer[]): string {
  if (!clouds.length) return "Clear";
  return clouds
    .map((c) => (c.base_ft !== null ? `${c.cover} ${c.base_ft}ft` : c.cover))
    .join(", ");
}

function formatTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function AviationWeather({ slug: _slug, icao }: Props) {
  const [data, setData] = useState<MetarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);

    fetch(`/api/py/metar?icao=${encodeURIComponent(icao)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: MetarData) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [icao]);

  const headingId = `aviation-heading-${icao}`;

  if (loading) {
    return (
      <section aria-labelledby={headingId} aria-label="Loading aviation weather">
        <div className="rounded-[var(--radius-card)] border border-primary/25 bg-surface-card p-4 shadow-sm" role="status" aria-label="Loading">
          <Skeleton className="h-5 w-48 mb-4" />
          <Skeleton className="h-4 w-full mb-2" />
          <Skeleton className="h-4 w-3/4 mb-4" />
          <Skeleton className="h-32 w-full" />
        </div>
      </section>
    );
  }

  if (error || !data) {
    return (
      <section aria-labelledby={headingId}>
        <div className="rounded-[var(--radius-card)] border border-primary/25 bg-surface-card p-4 shadow-sm">
          <h2 id={headingId} className="text-base font-semibold text-text-primary font-heading">
            Aviation Weather · {icao}
          </h2>
          <p className="mt-3 text-sm text-text-tertiary">Aviation data temporarily unavailable.</p>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId}>
      <div className="rounded-[var(--radius-card)] border border-primary/25 bg-surface-card p-4 shadow-sm">
        <h2 id={headingId} className="text-base font-semibold text-text-primary font-heading">
          Aviation Weather · {data.icao}
        </h2>

        {/* TAF */}
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-2">TAF</h3>
          {data.taf ? (
            <pre className="font-mono text-xs text-text-primary bg-surface-base rounded-[var(--radius-input)] p-3 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
              {data.taf}
            </pre>
          ) : (
            <p className="text-sm text-text-tertiary">No TAF available for this station.</p>
          )}
        </div>

        {/* METAR table */}
        <div className="mt-5">
          <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-2">METAR</h3>
          {data.metar.length === 0 ? (
            <p className="text-sm text-text-tertiary">No recent METAR observations.</p>
          ) : (
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-xs border-collapse min-w-[700px]" aria-label={`METAR observations for ${data.icao}`}>
                <thead>
                  <tr className="bg-surface-base text-text-secondary text-left">
                    <th className="px-2 py-2 font-semibold">Time</th>
                    <th className="px-2 py-2 font-semibold">Conditions</th>
                    <th className="px-2 py-2 font-semibold">Temp / Dew</th>
                    <th className="px-2 py-2 font-semibold">Wind</th>
                    <th className="px-2 py-2 font-semibold">Visibility</th>
                    <th className="px-2 py-2 font-semibold">Weather</th>
                    <th className="px-2 py-2 font-semibold">Clouds</th>
                    <th className="px-2 py-2 font-semibold">Pressure</th>
                    <th className="px-2 py-2 font-semibold">Change</th>
                    <th className="px-2 py-2 font-semibold">Raw</th>
                  </tr>
                </thead>
                <tbody>
                  {data.metar.map((obs, i) => (
                    <tr
                      key={i}
                      className="border-t border-surface-dim hover:bg-surface-base/50 transition-colors"
                    >
                      <td className="px-2 py-2 text-text-secondary whitespace-nowrap">{formatTime(obs.time)}</td>
                      <td className="px-2 py-2">
                        <span
                          className={`inline-flex items-center justify-center rounded-[var(--radius-input)] px-2 py-0.5 text-xs font-bold min-w-[3rem] ${FLIGHT_CATEGORY_STYLES[obs.flight_category] ?? "bg-surface-dim text-text-secondary"}`}
                          aria-label={`Flight category: ${obs.flight_category}`}
                        >
                          {obs.flight_category}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-text-primary whitespace-nowrap">
                        {obs.temp !== null ? `${Math.round(obs.temp)}°C` : "—"}
                        {" / "}
                        {obs.dewp !== null ? `${Math.round(obs.dewp)}°C` : "—"}
                      </td>
                      <td className="px-2 py-2 text-text-primary whitespace-nowrap">{formatWind(obs)}</td>
                      <td className="px-2 py-2 text-text-primary">{obs.visibility ?? "—"}</td>
                      <td className="px-2 py-2 text-text-secondary">{obs.weather ?? "—"}</td>
                      <td className="px-2 py-2 text-text-primary">{formatClouds(obs.clouds)}</td>
                      <td className="px-2 py-2 text-text-primary whitespace-nowrap">
                        {obs.pressure_hpa !== null ? `${obs.pressure_hpa} hPa` : "—"}
                      </td>
                      <td className="px-2 py-2 text-text-secondary">{obs.change ?? "—"}</td>
                      <td className="px-2 py-2 font-mono text-text-tertiary max-w-[200px] truncate" title={obs.raw}>
                        {obs.raw}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p className="mt-3 text-xs text-text-tertiary">
          METAR data from{" "}
          <span className="font-medium">Aviation Weather Center (NOAA)</span>
          {" · "}{data.icao}
        </p>
      </div>
    </section>
  );
}
