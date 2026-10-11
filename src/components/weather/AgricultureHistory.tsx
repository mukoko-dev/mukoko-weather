"use client";

import { useEffect, useState } from "react";
import {
  formatAnomaly,
  formatMm,
  formatTempC,
  summarizeHistory,
  type HistorySummary,
} from "@/lib/agriculture";

/**
 * The past 30 days against climate normals: recorded rain and mean
 * highs/lows from `/api/py/history`, today's 1991–2020 normal high/low from
 * `/api/py/normals`, and the forecast model's own 30-day rain total as a
 * cross-check when few days are recorded. Failures fall back to what is known.
 */

interface Props {
  slug: string;
  lat: number;
  lon: number;
  /** The forecast model's past-30-day rain (from /api/py/agriculture). */
  modelRain30dMm: number | null;
}

interface Normals {
  available: boolean;
  normalHigh?: number | null;
  normalLow?: number | null;
}

const WINDOW_DAYS = 30;

/** "YYYY-MM-DD" for `n` days ago (the normals API only uses month and day). */
function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

function averageNormals(a: Normals, b: Normals): Normals {
  if (!a.available || !b.available) return b.available ? b : a;
  const avg = (x?: number | null, y?: number | null) =>
    typeof x === "number" && typeof y === "number"
      ? Math.round(((x + y) / 2) * 10) / 10
      : (x ?? y ?? null);
  return {
    available: true,
    normalHigh: avg(a.normalHigh, b.normalHigh),
    normalLow: avg(a.normalLow, b.normalLow),
  };
}

export function AgricultureHistory({ slug, lat, lon, modelRain30dMm }: Props) {
  const [history, setHistory] = useState<HistorySummary | null>(null);
  const [normals, setNormals] = useState<Normals | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/py/history?location=${encodeURIComponent(slug)}&days=30`)
      .then(async (res) => (res.ok ? res.json() : { data: [] }))
      .then((json: { data?: unknown[] }) => {
        if (live) setHistory(summarizeHistory((json.data ?? []) as never[]));
      })
      .catch(() => live && setHistory(summarizeHistory([])));
    // Normals are for one calendar day, and temperatures slope across a
    // 30-day window, so compare against the mean of the normals at both ends
    // of it. Sequential on purpose: the first call builds the cell's table
    // (cached afterwards), the second reads it.
    const getNormals = async (date: string): Promise<Normals> => {
      const res = await fetch(
        `/api/py/normals?lat=${lat}&lon=${lon}&date=${date}`,
      );
      return res.ok ? ((await res.json()) as Normals) : { available: false };
    };
    (async () => {
      const end = await getNormals(isoDaysAgo(0));
      const start = end.available
        ? await getNormals(isoDaysAgo(WINDOW_DAYS - 1))
        : end;
      return averageNormals(start, end);
    })()
      .then((n) => live && setNormals(n))
      .catch(() => live && setNormals({ available: false }));
    return () => {
      live = false;
    };
  }, [slug, lat, lon]);

  const normalHigh = normals?.available ? normals.normalHigh : null;
  const normalLow = normals?.available ? normals.normalLow : null;
  const highAnomaly = formatAnomaly(history?.meanHigh, normalHigh);
  const lowAnomaly = formatAnomaly(history?.meanLow, normalLow);
  const loading = history === null;
  const normalsPending = normals === null;

  return (
    <section aria-labelledby="agri-history" className="acacia space-y-3">
      <h2 id="agri-history" className="giraffe">
        Past 30 days against normal
      </h2>
      {loading ? (
        <div
          role="status"
          aria-label="Loading history"
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
        >
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-[var(--radius-card)] bg-surface-dim"
            />
          ))}
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="meerkat">
              <dt className="dove">Rain on file</dt>
              <dd className="text-base font-medium text-text-primary">
                {history.rainMm != null ? formatMm(history.rainMm) : "—"}
                <span className="dove block">
                  {history.days} days stored (forecast or archive, not a gauge)
                </span>
              </dd>
            </div>
            <div className="meerkat">
              <dt className="dove">Rain (forecast model)</dt>
              <dd className="text-base font-medium text-text-primary">
                {formatMm(modelRain30dMm)}
              </dd>
            </div>
            <div className="meerkat">
              <dt className="dove">Mean high</dt>
              <dd className="text-base font-medium text-text-primary">
                {formatTempC(history.meanHigh)}
                <span className="dove block">
                  Normal {normalsPending ? "…" : formatTempC(normalHigh)}
                  {highAnomaly ? ` · ${highAnomaly}` : ""}
                </span>
              </dd>
            </div>
            <div className="meerkat">
              <dt className="dove">Mean low</dt>
              <dd className="text-base font-medium text-text-primary">
                {formatTempC(history.meanLow)}
                <span className="dove block">
                  Normal {normalsPending ? "…" : formatTempC(normalLow)}
                  {lowAnomaly ? ` · ${lowAnomaly}` : ""}
                </span>
              </dd>
            </div>
          </dl>
          <p className="dove">
            Normals: 1991–2020 average over the same 30 days (ERA5 via
            Open-Meteo).
          </p>
        </>
      )}
    </section>
  );
}
