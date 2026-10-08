"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { getFlightCategoryClass } from "@/lib/flight-category-styles";

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

/** One airport the nearest-report search considered. */
export interface NearestCandidate {
  icao: string;
  name: string;
  distanceKm: number;
  /** Has a METAR within the search's max age. */
  reported: boolean;
  observedAt: string | null;
  ageMinutes: number | null;
}

/** Response of GET /api/py/aviation/nearest-metar. */
interface NearestResponse {
  status: "ok" | "no_recent_report" | "no_airports" | "unavailable";
  message: string | null;
  searchRadiusKm: number;
  maxAgeMinutes: number;
  icao: string | null;
  name: string | null;
  distanceKm: number | null;
  observedAt: string | null;
  ageMinutes: number | null;
  metar: MetarObs[];
  taf: string | null;
  source: string;
  candidates: NearestCandidate[];
}

/** Response of GET /api/py/metar?icao=. */
interface StationResponse {
  icao: string;
  metar: MetarObs[];
  taf: string | null;
  source: string;
}

/** The station the card is currently showing. */
interface ReportView {
  icao: string;
  name: string | null;
  distanceKm: number | null;
  ageMinutes: number | null;
  metar: MetarObs[];
  taf: string | null;
}

interface Props {
  slug: string;
  lat: number;
  lon: number;
}

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

/**
 * Cloud-cover codes that constitute a *ceiling* for aviation — the lowest
 * BKN (broken) or OVC (overcast) layer. FEW/SCT layers do not form a ceiling.
 */
const CEILING_COVERS = new Set(["BKN", "OVC"]);

/** Ranking of cloud-cover codes by density (sky clear → overcast). */
const COVER_RANK: Record<string, number> = {
  SKC: 0,
  CLR: 0,
  NCD: 0,
  NSC: 0,
  FEW: 1,
  SCT: 2,
  BKN: 3,
  OVC: 4,
  VV: 5,
};

const COVER_LABELS: Record<string, string> = {
  SKC: "Sky clear",
  CLR: "Clear",
  NCD: "No cloud",
  NSC: "No sig. cloud",
  FEW: "Few",
  SCT: "Scattered",
  BKN: "Broken",
  OVC: "Overcast",
  VV: "Vertical vis.",
};

/**
 * Cloud ceiling in feet — the lowest broken/overcast layer base. Returns null
 * when no BKN/OVC layer is present (aviation "unlimited" ceiling). Critical for
 * VFR/MVFR/IFR/LIFR flight-category determination.
 */
export function deriveCeilingFt(clouds: CloudLayer[]): number | null {
  let ceiling: number | null = null;
  for (const c of clouds) {
    if (CEILING_COVERS.has(c.cover) && c.base_ft !== null) {
      if (ceiling === null || c.base_ft < ceiling) ceiling = c.base_ft;
    }
  }
  return ceiling;
}

/**
 * Lowest cloud base (feet) across *all* reported layers, or null when the sky
 * is clear / no bases are reported.
 */
export function deriveCloudBaseFt(clouds: CloudLayer[]): number | null {
  let base: number | null = null;
  for (const c of clouds) {
    if (c.base_ft !== null && (base === null || c.base_ft < base))
      base = c.base_ft;
  }
  return base;
}

/** Human-readable overall cloud cover, taken from the densest reported layer. */
export function summarizeCloudCover(clouds: CloudLayer[]): string {
  if (!clouds.length) return "Clear";
  let densest = clouds[0];
  for (const c of clouds) {
    if ((COVER_RANK[c.cover] ?? -1) > (COVER_RANK[densest.cover] ?? -1))
      densest = c;
  }
  return COVER_LABELS[densest.cover] ?? densest.cover;
}

/** Format a feet altitude for display, e.g. 2500 → "2,500 ft". */
function formatFt(ft: number | null): string {
  return ft === null ? "—" : `${ft.toLocaleString("en-GB")} ft`;
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

/** Human age of a report: "just now", "35 min ago", "2 h ago". */
export function formatAge(minutes: number | null): string {
  if (minutes === null) return "time unknown";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

/** Whole minutes between an ISO timestamp and `nowMs`, or null if unparseable. */
export function minutesSince(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 60_000));
}

/**
 * The one-line station summary, e.g.
 * "FVRG Harare (Robert Gabriel Mugabe Intl) · 12 km · 35 min ago".
 */
export function formatReportLine(view: ReportView): string {
  const parts = [view.icao];
  if (view.name) parts.push(view.name);
  let line = parts.join(" ");
  if (view.distanceKm !== null) line += ` · ${Math.round(view.distanceKm)} km`;
  line += ` · ${formatAge(view.ageMinutes)}`;
  return line;
}

/** A loaded response, tagged with the request key it answers. */
interface Loaded<T> {
  key: string;
  ok: boolean;
  data?: T;
}

/** A station the user picked from the chip row. */
interface Pick {
  key: string;
  icao: string;
  name: string | null;
  distanceKm: number | null;
}

export function AviationWeather({ slug, lat, lon }: Props) {
  const coordKey = `${lat},${lon}`;

  // The user may pick one of the nearby stations. The pick is keyed by the
  // coordinates it was made for, so moving to another location resets it to
  // the nearest reporting station without a setState-in-effect.
  const [pick, setPick] = useState<Pick | null>(null);
  const picked = pick?.key === coordKey ? pick : null;
  const pickedIcao = picked?.icao ?? null;

  // Two slots: the nearest search (kept while a chip is picked, so the chip
  // row stays populated) and the picked station's report.
  const [nearest, setNearest] = useState<Loaded<NearestResponse> | null>(null);
  const [station, setStation] = useState<
    (Loaded<StationResponse> & { ageMinutes: number | null }) | null
  >(null);

  const requestKey = pickedIcao
    ? `${coordKey}|${pickedIcao}`
    : `${coordKey}|nearest`;

  useEffect(() => {
    let cancelled = false;
    const url = pickedIcao
      ? `/api/py/metar?icao=${encodeURIComponent(pickedIcao)}`
      : `/api/py/aviation/nearest-metar?lat=${encodeURIComponent(String(lat))}&lon=${encodeURIComponent(String(lon))}`;

    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: NearestResponse | StationResponse) => {
        if (cancelled) return;
        if (pickedIcao) {
          const data = d as StationResponse;
          setStation({
            key: requestKey,
            ok: true,
            data,
            ageMinutes: minutesSince(data.metar[0]?.time ?? null, Date.now()),
          });
        } else {
          setNearest({ key: requestKey, ok: true, data: d as NearestResponse });
        }
      })
      .catch(() => {
        if (cancelled) return;
        if (pickedIcao)
          setStation({ key: requestKey, ok: false, ageMinutes: null });
        else setNearest({ key: requestKey, ok: false });
      });

    return () => {
      cancelled = true;
    };
  }, [requestKey, pickedIcao, lat, lon]);

  const nearestCurrent =
    nearest?.key === `${coordKey}|nearest` ? nearest : null;
  const stationCurrent = picked && station?.key === requestKey ? station : null;
  const loading = picked ? stationCurrent === null : nearestCurrent === null;

  const headingId = `aviation-heading-${slug}`;

  // Resolve the displayed view, the message, and the candidate list.
  let view: ReportView | null = null;
  let message: string | null = null;
  let failed = false;
  const candidates: NearestCandidate[] = nearestCurrent?.data?.candidates ?? [];

  if (picked) {
    if (stationCurrent && !stationCurrent.ok) failed = true;
    else if (stationCurrent?.data) {
      view = {
        icao: stationCurrent.data.icao,
        name: picked.name,
        distanceKm: picked.distanceKm,
        ageMinutes: stationCurrent.ageMinutes,
        metar: stationCurrent.data.metar,
        taf: stationCurrent.data.taf,
      };
    }
  } else if (nearestCurrent) {
    const n = nearestCurrent.data;
    if (!nearestCurrent.ok || !n) failed = true;
    else if (n.status === "ok" && n.icao) {
      view = {
        icao: n.icao,
        name: n.name,
        distanceKm: n.distanceKm,
        ageMinutes: n.ageMinutes,
        metar: n.metar,
        taf: n.taf,
      };
    } else {
      message = n.message;
    }
  }

  // Airport picker — shown when the search found more than one airport. Chips
  // for airports with no recent report are disabled rather than hidden, so the
  // user can see why a station is unavailable.
  const picker =
    candidates.length > 1 ? (
      // Reserved-height, single-line row: its height is fixed at the touch
      // target minimum whatever the chip count, so the DB-backed station list
      // replacing the static seed (or a different count) can't reflow the card
      // (CLS). Chips never wrap — the row scrolls sideways instead.
      <div
        className="mt-4 flex min-h-[var(--touch-target-min)] items-center gap-2 overflow-x-auto"
        role="group"
        aria-label="Nearby aviation stations"
      >
        {candidates.map((s) => {
          const active = view?.icao === s.icao;
          const base =
            "inline-flex items-center gap-1 rounded-[var(--radius-input)] px-3 py-1.5 text-sm font-medium transition-colors";
          const cls = active
            ? "bg-primary/10 text-text-primary ring-1 ring-primary/40"
            : "border border-border bg-transparent text-text-secondary hover:text-text-primary hover:border-text-tertiary/40";
          const title = s.reported
            ? `${s.name} · ${formatAge(s.ageMinutes)}`
            : `${s.name} · no METAR in the last 3 hours`;
          return (
            <button
              key={s.icao}
              type="button"
              onClick={() =>
                setPick({
                  key: coordKey,
                  icao: s.icao,
                  name: s.name,
                  distanceKm: s.distanceKm,
                })
              }
              disabled={!s.reported}
              aria-pressed={active}
              className={`${base} ${cls} shrink-0 disabled:cursor-not-allowed disabled:opacity-50`}
              title={title}
            >
              <span className="font-mono text-xs font-bold">{s.icao}</span>
              <span className="text-xs opacity-70">
                {Math.round(s.distanceKm)}km
              </span>
            </button>
          );
        })}
      </div>
    ) : null;

  return (
    <section aria-labelledby={headingId}>
      <div className="baobab">
        <h2 id={headingId} className="giraffe">
          {view ? `Aviation Weather · ${view.icao}` : "Aviation Weather"}
        </h2>

        {view && (
          <p className="mt-0.5 text-sm text-text-tertiary">
            {picked ? "Station" : "Nearest report"}: {formatReportLine(view)}
          </p>
        )}

        {picker}

        {loading && (
          <div className="mt-4" role="status" aria-label="Loading">
            <Skeleton className="h-4 w-full mb-2" />
            <Skeleton className="h-4 w-3/4 mb-4" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}

        {!loading && failed && (
          <p className="mt-4 text-sm text-text-tertiary">
            Aviation data temporarily unavailable.
          </p>
        )}

        {!loading && !failed && !view && message && (
          <p className="mt-4 text-sm text-text-tertiary">{message}</p>
        )}

        {!loading && !failed && view && (
          <>
            {/* Clouds & Ceiling — prominent aviation summary for the latest METAR.
            Cloud ceiling (lowest BKN/OVC layer) is the driver of the VFR/MVFR/
            IFR/LIFR flight category (computed server-side in _metar.py). */}
            {view.metar.length > 0 &&
              (() => {
                const latest = view.metar[0];
                const ceiling = deriveCeilingFt(latest.clouds);
                const base = deriveCloudBaseFt(latest.clouds);
                const cover = summarizeCloudCover(latest.clouds);
                return (
                  <div
                    className="mt-4 acacia"
                    aria-labelledby={`clouds-heading-${view.icao}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h3
                        id={`clouds-heading-${view.icao}`}
                        className="text-sm font-semibold text-text-secondary uppercase tracking-wide"
                      >
                        Clouds &amp; Ceiling
                      </h3>
                      <span
                        className={`inline-flex items-center justify-center rounded-[var(--radius-input)] px-2 py-0.5 text-xs font-bold min-w-[3rem] ${getFlightCategoryClass(latest.flight_category)}`}
                        aria-label={`Flight category: ${latest.flight_category}`}
                      >
                        {latest.flight_category}
                      </span>
                    </div>
                    <dl className="mt-3 grid grid-cols-3 gap-3">
                      <div>
                        <dt className="text-xs text-text-tertiary">
                          Cloud Cover
                        </dt>
                        <dd className="mt-0.5 text-base font-semibold text-text-primary">
                          {cover}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-text-tertiary">
                          Cloud Base
                        </dt>
                        <dd className="mt-0.5 text-base font-semibold text-text-primary">
                          {formatFt(base)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-text-tertiary">Ceiling</dt>
                        <dd className="mt-0.5 text-base font-semibold text-text-primary">
                          {ceiling === null ? "Unlimited" : formatFt(ceiling)}
                        </dd>
                      </div>
                    </dl>
                    <p className="mt-2 text-xs text-text-tertiary">
                      Ceiling is the lowest broken (BKN) or overcast (OVC) layer
                      — the primary driver of the flight category.
                    </p>
                  </div>
                );
              })()}

            {/* TAF */}
            <div className="mt-4">
              <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-2">
                TAF
              </h3>
              {view.taf ? (
                <pre className="font-mono text-xs text-text-primary bg-surface-base rounded-[var(--radius-input)] p-3 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
                  {view.taf}
                </pre>
              ) : (
                <p className="text-sm text-text-tertiary">
                  No TAF available for this station.
                </p>
              )}
            </div>

            {/* METAR table */}
            <div className="mt-5">
              <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-2">
                METAR
              </h3>
              {view.metar.length === 0 ? (
                <p className="text-sm text-text-tertiary">
                  No recent METAR observations.
                </p>
              ) : (
                <div className="overflow-x-auto -mx-1">
                  <table
                    className="w-full text-xs border-collapse min-w-[700px]"
                    aria-label={`METAR observations for ${view.icao}`}
                  >
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
                      {view.metar.map((obs, i) => (
                        <tr
                          key={i}
                          className="border-t border-surface-dim hover:bg-surface-base/50 transition-colors"
                        >
                          <td className="px-2 py-2 text-text-secondary whitespace-nowrap">
                            {formatTime(obs.time)}
                          </td>
                          <td className="px-2 py-2">
                            <span
                              className={`inline-flex items-center justify-center rounded-[var(--radius-input)] px-2 py-0.5 text-xs font-bold min-w-[3rem] ${getFlightCategoryClass(obs.flight_category)}`}
                              aria-label={`Flight category: ${obs.flight_category}`}
                            >
                              {obs.flight_category}
                            </span>
                          </td>
                          <td className="px-2 py-2 text-text-primary whitespace-nowrap">
                            {obs.temp !== null
                              ? `${Math.round(obs.temp)}°C`
                              : "—"}
                            {" / "}
                            {obs.dewp !== null
                              ? `${Math.round(obs.dewp)}°C`
                              : "—"}
                          </td>
                          <td className="px-2 py-2 text-text-primary whitespace-nowrap">
                            {formatWind(obs)}
                          </td>
                          <td className="px-2 py-2 text-text-primary">
                            {obs.visibility ?? "—"}
                          </td>
                          <td className="px-2 py-2 text-text-secondary">
                            {obs.weather ?? "—"}
                          </td>
                          <td className="px-2 py-2 text-text-primary">
                            {formatClouds(obs.clouds)}
                          </td>
                          <td className="px-2 py-2 text-text-primary whitespace-nowrap">
                            {obs.pressure_hpa !== null
                              ? `${obs.pressure_hpa} hPa`
                              : "—"}
                          </td>
                          <td className="px-2 py-2 text-text-secondary">
                            {obs.change ?? "—"}
                          </td>
                          <td
                            className="px-2 py-2 font-mono text-text-tertiary max-w-[200px] truncate"
                            title={obs.raw}
                          >
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
              <span className="font-medium">
                Aviation Weather Center (NOAA)
              </span>
              {" · "}
              {view.icao}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
