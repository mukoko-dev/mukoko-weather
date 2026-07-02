"use client";

import { useEffect, useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { getAirportByIcao } from "@/lib/icao-codes";

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

/** A selectable aviation station shown in the airport picker. */
export interface NearbyAirport {
  icao: string;
  name: string;
  distanceKm?: number;
}

interface Props {
  slug: string;
  icao: string;
  /**
   * Additional nearby ICAO stations the user can switch between. The primary
   * `icao` is always shown first; any entries here are merged in (deduped).
   */
  nearby?: NearbyAirport[];
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

export function AviationWeather({ slug: _slug, icao, nearby }: Props) {
  // Build the list of selectable stations: the primary icao first, then any
  // nearby stations (deduped). Names are resolved from the airport registry.
  const stations = useMemo<NearbyAirport[]>(() => {
    const seen = new Set<string>();
    const list: NearbyAirport[] = [];
    const push = (a: NearbyAirport) => {
      const code = a.icao.toUpperCase();
      if (seen.has(code)) return;
      seen.add(code);
      list.push({ ...a, icao: code });
    };
    push({ icao, name: getAirportByIcao(icao)?.name ?? icao });
    for (const a of nearby ?? []) push(a);
    return list;
  }, [icao, nearby]);

  // Currently-selected station, derived so it auto-resets to the primary icao
  // whenever that prop changes (e.g. navigating between locations) without
  // calling setState inside an effect. `selection` remembers which primary icao
  // the user's choice was made against; if the primary changes, we fall back.
  const [selection, setSelection] = useState<{ base: string; icao: string } | null>(null);
  const selectedIcao = selection?.base === icao ? selection.icao : icao;
  const setSelectedIcao = (next: string) => setSelection({ base: icao, icao: next });

  // Store the full response keyed by the icao it was fetched for. Loading,
  // error, and data are *derived* from whether the latest response matches the
  // currently-selected icao — this avoids setState-in-effect when icao changes
  // (the previous pattern called setLoading(true) / setError(false) synchronously
  // at the top of the effect, which trips react-hooks/set-state-in-effect).
  const [response, setResponse] = useState<{
    icao: string;
    data: MetarData | null;
    error: boolean;
  } | null>(null);

  const isCurrentResponse = response?.icao === selectedIcao;
  const loading = !isCurrentResponse;
  const error = isCurrentResponse && response.error;
  const data = isCurrentResponse ? response.data : null;

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/py/metar?icao=${encodeURIComponent(selectedIcao)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: MetarData) => {
        if (!cancelled) setResponse({ icao: selectedIcao, data: d, error: false });
      })
      .catch(() => {
        if (!cancelled) setResponse({ icao: selectedIcao, data: null, error: true });
      });

    return () => { cancelled = true; };
  }, [selectedIcao]);

  const headingId = `aviation-heading-${icao}`;

  // Airport picker — only rendered when there is more than one station to choose
  // between. Lets the user switch which nearby station's METAR/TAF they view.
  const picker =
    stations.length > 1 ? (
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Nearby aviation stations">
        {stations.map((s) => {
          const active = s.icao === selectedIcao;
          const base =
            "inline-flex items-center gap-1 rounded-[var(--radius-input)] px-3 py-1.5 text-sm font-medium transition-colors";
          const cls = active
            ? "bg-primary/10 text-text-primary ring-1 ring-primary/40"
            : "border border-border bg-transparent text-text-secondary hover:text-text-primary hover:border-text-tertiary/40";
          return (
            <button
              key={s.icao}
              type="button"
              onClick={() => setSelectedIcao(s.icao)}
              aria-pressed={active}
              className={`${base} ${cls}`}
              title={s.name}
            >
              <span className="font-mono text-xs font-bold">{s.icao}</span>
              {s.distanceKm !== undefined && (
                <span className="text-xs opacity-70">{Math.round(s.distanceKm)}km</span>
              )}
            </button>
          );
        })}
      </div>
    ) : null;

  const selectedName = stations.find((s) => s.icao === selectedIcao)?.name;

  return (
    <section aria-labelledby={headingId}>
      <div className="baobab">
        <h2 id={headingId} className="giraffe">
          Aviation Weather · {selectedIcao}
        </h2>
        {selectedName && selectedName !== selectedIcao && (
          <p className="mt-0.5 text-sm text-text-tertiary">{selectedName}</p>
        )}

        {picker}

        {loading && (
          <div className="mt-4" role="status" aria-label="Loading">
            <Skeleton className="h-4 w-full mb-2" />
            <Skeleton className="h-4 w-3/4 mb-4" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}

        {!loading && (error || !data) && (
          <p className="mt-4 text-sm text-text-tertiary">Aviation data temporarily unavailable.</p>
        )}

        {!loading && !error && data && (
          <>
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
          </>
        )}
      </div>
    </section>
  );
}
