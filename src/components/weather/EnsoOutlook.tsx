"use client";

import { useEffect, useId, useState } from "react";
import { SectionHeader } from "@/components/ui/section-header";
import { EnsoOutlookSkeleton } from "@/components/weather/SectionSkeleton";
import { ensoImpact, type EnsoPhase } from "@/lib/enso";

/**
 * El Niño / La Niña seasonal outlook card.
 *
 * Fetches `/api/py/enso` (NOAA CPC Oceanic Niño Index, cached server-side for
 * 12 h) and shows the latest phase, strength, ONI value with its season, the
 * last few seasons, and region-aware impact lines for this location's country.
 *
 * ENSO is a seasonal climate driver, not a forecast for today, and the card
 * says so. When the upstream is unavailable the card renders nothing, so the
 * location page is never cluttered with an error message.
 */

export interface EnsoSeason {
  season: string;
  year: number;
  oni: number;
}

export interface EnsoOutlookResponse {
  available: boolean;
  season: string | null;
  year: number | null;
  oni: number | null;
  phase: EnsoPhase | null;
  strength: "weak" | "moderate" | "strong" | "very strong" | null;
  series: EnsoSeason[];
  source: string;
  fetchedAt: string | null;
}

interface Props {
  /** Location latitude (degrees, WGS 84) — used for the region rule. */
  lat: number;
  /** Location longitude (degrees, WGS 84) — used for the region rule. */
  lon: number;
  /** ISO 3166-1 alpha-2 country code, when known. */
  countryCode?: string;
}

/** Phase badge — solid fill, paired with the matching `-fg` foreground token. */
export const ENSO_PHASE_CLASS: Record<EnsoPhase, string> = {
  "El Niño": "bg-severity-moderate text-severity-fg",
  "La Niña": "bg-severity-cold text-severity-fg",
  Neutral: "bg-surface-base text-text-secondary",
};

/** Strength is shown as an outline label, not a colour, so it doesn't compete with phase. */
export const ENSO_STRENGTH_LABEL: Record<
  NonNullable<EnsoOutlookResponse["strength"]>,
  string
> = {
  weak: "Weak",
  moderate: "Moderate",
  strong: "Strong",
  "very strong": "Very strong",
};

/** Signed ONI with two decimals, e.g. "+2.16" or "−0.43". */
export function formatOni(oni: number): string {
  const sign = oni < 0 ? "−" : "+";
  return `${sign}${Math.abs(oni).toFixed(2)}`;
}

/** An available outlook with every field the card renders guaranteed non-null. */
type ReadyOutlook = EnsoOutlookResponse & {
  phase: EnsoPhase;
  oni: number;
  season: string;
  year: number;
};

type EnsoState =
  | { status: "loading" }
  | { status: "ready"; data: ReadyOutlook }
  | { status: "unavailable" };

export function EnsoOutlook({ lat, lon, countryCode }: Props) {
  const headingId = useId();
  const [state, setState] = useState<EnsoState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    fetch("/api/py/enso", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<EnsoOutlookResponse>;
      })
      .then((json) => {
        if (cancelled) return;
        if (
          json.available &&
          json.phase &&
          json.oni !== null &&
          json.season !== null &&
          json.year !== null
        ) {
          setState({
            status: "ready",
            data: {
              ...json,
              phase: json.phase,
              oni: json.oni,
              season: json.season,
              year: json.year,
            },
          });
        } else {
          setState({ status: "unavailable" });
        }
      })
      .catch((err: unknown) => {
        if (
          cancelled ||
          (err as { name?: string } | null)?.name === "AbortError"
        )
          return;
        setState({ status: "unavailable" });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  if (state.status === "loading") return <EnsoOutlookSkeleton />;
  if (state.status === "unavailable") return null;

  const { data } = state;
  const impact = ensoImpact(data.phase, countryCode, lat, lon);

  return (
    <section aria-labelledby={headingId} className="baobab">
      <SectionHeader title="El Niño / La Niña outlook" headingId={headingId} />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span
          className={`rounded-[var(--radius-badge)] px-3 py-1 text-sm font-medium ${ENSO_PHASE_CLASS[data.phase]}`}
        >
          {data.phase}
        </span>
        {data.strength && (
          <span className="rounded-[var(--radius-badge)] border border-border px-3 py-1 text-sm text-text-secondary">
            {ENSO_STRENGTH_LABEL[data.strength]}
          </span>
        )}
      </div>

      <p className="dove mt-3">
        ONI {formatOni(data.oni)} for {data.season} {data.year}
      </p>

      {data.series.length > 0 && (
        <ul
          aria-label="Recent seasons"
          className="mt-3 flex flex-wrap gap-2 text-sm text-text-tertiary"
        >
          {data.series.map((s) => (
            <li
              key={`${s.season}-${s.year}`}
              className="rounded-[var(--radius-input)] bg-surface-base px-2.5 py-1"
            >
              {s.season} {s.year} {formatOni(s.oni)}
            </li>
          ))}
        </ul>
      )}

      <ul className="gazelle mt-4 list-disc space-y-2 pl-5">
        {impact.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      <p className="dove mt-4">
        Seasonal outlook, not a forecast for today. Source: {data.source}.
      </p>
    </section>
  );
}
