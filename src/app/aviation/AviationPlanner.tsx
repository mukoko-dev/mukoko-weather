"use client";

import { useState, useRef, useCallback } from "react";
import { useDebounce } from "@/lib/use-debounce";
import { getIcaoForSlug } from "@/lib/icao-codes";
import { SearchIcon, MapPinIcon, NavigationIcon } from "@/lib/weather-icons";
import type { AirportBriefing, BriefingData, MetarObs } from "./AviationBriefingPDF";

// Flight category badge colours match severity tokens
function FlightCategoryBadge({ fc }: { fc: string }) {
  const cls =
    fc === "VFR" ? "bg-severity-low text-white" :
    fc === "MVFR" ? "bg-primary text-primary-foreground" :
    fc === "IFR" ? "bg-severity-high text-white" :
    fc === "LIFR" ? "bg-severity-severe text-white" :
    "bg-surface-dim text-text-secondary";
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-bold tracking-wide ${cls}`}>
      {fc}
    </span>
  );
}

function windStr(obs: MetarObs): string {
  if (obs.wind_variable) return `Variable ${obs.wind_speed}kt`;
  if (!obs.wind_dir && obs.wind_speed === 0) return "Calm";
  return `${String(obs.wind_dir).padStart(3, "0")}° / ${obs.wind_speed}kt`;
}

function cloudsStr(obs: MetarObs): string {
  if (!obs.clouds?.length) return "Clear";
  return obs.clouds.map((c) => `${c.cover} ${c.base_ft}ft`).join(", ");
}

interface LocationResult { slug: string; name: string; province: string; country?: string }

function AirportSearch({
  label,
  value,
  onChange,
}: {
  label: string;
  value: LocationResult | null;
  onChange: (loc: LocationResult | null) => void;
}) {
  const [query, setQuery] = useState(value?.name ?? "");
  const [results, setResults] = useState<LocationResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounced = useDebounce(query, 300);
  const containerRef = useRef<HTMLDivElement>(null);

  const search = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setResults([]); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/py/search?q=${encodeURIComponent(q)}&limit=8`);
      if (res.ok) {
        const data = await res.json();
        setResults((data.locations ?? []).map((l: { slug: string; name: string; province: string; country?: string }) => ({
          slug: l.slug, name: l.name, province: l.province, country: l.country,
        })));
      }
    } finally { setLoading(false); }
  }, []);

  // Trigger search on debounced value
  useState(() => { if (debounced !== (value?.name ?? "")) search(debounced); });

  const icaoForResult = (r: LocationResult) => getIcaoForSlug(r.slug);

  const select = (r: LocationResult) => {
    onChange(r);
    setQuery(r.name);
    setOpen(false);
    setResults([]);
  };

  const clear = () => { onChange(null); setQuery(""); setResults([]); };

  return (
    <div ref={containerRef} className="relative">
      <label className="block text-sm font-medium text-text-secondary mb-1">{label}</label>
      <div className="relative">
        <SearchIcon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" aria-hidden="true" />
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); if (!e.target.value) clear(); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Search city or airport name…"
          className="w-full rounded-[var(--radius-input)] border border-text-tertiary/20 bg-surface-base pl-9 pr-4 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          aria-label={label}
          aria-expanded={open}
          aria-autocomplete="list"
        />
        {loading && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary text-xs">…</span>
        )}
      </div>

      {value && (
        <div className="mt-1.5 flex items-center gap-2 rounded-[var(--radius-input)] bg-primary/8 px-3 py-1.5">
          <MapPinIcon size={14} className="text-primary shrink-0" aria-hidden="true" />
          <span className="text-sm font-medium text-text-primary flex-1 truncate">{value.name}</span>
          {icaoForResult(value)
            ? <span className="text-xs font-mono text-primary font-bold">{icaoForResult(value)}</span>
            : <span className="text-xs text-severity-moderate">No METAR station</span>
          }
          <button type="button" onClick={clear} className="ml-1 text-text-tertiary hover:text-text-primary text-xs" aria-label="Clear selection">✕</button>
        </div>
      )}

      {open && results.length > 0 && !value && (
        <ul className="absolute z-50 mt-1 w-full rounded-[var(--radius-card)] border border-text-tertiary/15 bg-surface-card shadow-lg overflow-hidden" role="listbox">
          {results.map((r) => {
            const icao = icaoForResult(r);
            return (
              <li key={r.slug} role="option" aria-selected={false}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-dim transition-colors"
                  onMouseDown={() => select(r)}
                >
                  <MapPinIcon size={14} className="text-text-tertiary shrink-0" aria-hidden="true" />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-text-primary">{r.name}</span>
                    <span className="ml-1.5 text-xs text-text-tertiary">{r.province}</span>
                  </div>
                  {icao
                    ? <span className="text-xs font-mono font-bold text-primary">{icao}</span>
                    : <span className="text-xs text-text-tertiary">No METAR</span>
                  }
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function MetarCard({ obs }: { obs: MetarObs }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-primary/15 bg-surface-base p-4">
      <div className="flex items-center justify-between mb-3">
        <FlightCategoryBadge fc={obs.flight_category} />
        <span className="text-xs text-text-tertiary">
          {new Date(obs.time).toLocaleTimeString("en-ZW", { hour: "2-digit", minute: "2-digit", hour12: false })} UTC
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm mb-3 sm:grid-cols-4">
        <div>
          <p className="text-xs text-text-tertiary">Temp / Dew</p>
          <p className="font-medium text-text-primary">{obs.temp}° / {obs.dewp}°C</p>
        </div>
        <div>
          <p className="text-xs text-text-tertiary">Wind</p>
          <p className="font-medium text-text-primary">{windStr(obs)}</p>
        </div>
        <div>
          <p className="text-xs text-text-tertiary">Visibility</p>
          <p className="font-medium text-text-primary">{obs.visibility === "9999" ? ">10km" : `${obs.visibility}m`}</p>
        </div>
        <div>
          <p className="text-xs text-text-tertiary">QNH</p>
          <p className="font-medium text-text-primary">{obs.pressure_hpa ? `${obs.pressure_hpa} hPa` : "—"}</p>
        </div>
      </div>
      <div className="text-sm mb-3">
        <p className="text-xs text-text-tertiary mb-0.5">Clouds</p>
        <p className="text-text-primary">{cloudsStr(obs)}</p>
      </div>
      <pre className="text-xs font-mono bg-surface-dim rounded p-2 whitespace-pre-wrap break-all text-text-secondary">{obs.raw}</pre>
    </div>
  );
}

function AirportBriefingCard({ briefing, title }: { briefing: AirportBriefing; title: string }) {
  const latest = briefing.metar[0];
  return (
    <section aria-labelledby={`${briefing.icao}-heading`} className="space-y-3">
      <div className="flex items-center gap-3">
        <h2 id={`${briefing.icao}-heading`} className="text-base font-semibold text-text-primary font-heading">
          {title}: <span className="font-mono text-primary">{briefing.icao}</span> — {briefing.name}
        </h2>
        {latest && <FlightCategoryBadge fc={latest.flight_category} />}
      </div>
      {latest ? <MetarCard obs={latest} /> : (
        <p className="text-sm text-text-secondary">No METAR observations available.</p>
      )}
      {briefing.taf ? (
        <div>
          <p className="text-xs font-medium text-text-tertiary mb-1">TAF</p>
          <pre className="text-xs font-mono bg-surface-dim rounded-[var(--radius-input)] p-3 whitespace-pre-wrap break-all text-text-secondary overflow-x-auto">{briefing.taf}</pre>
        </div>
      ) : (
        <p className="text-xs text-text-tertiary">No TAF available for this station.</p>
      )}
      {(briefing.sunrise || briefing.sunset) && (
        <div className="flex gap-6 text-sm">
          {briefing.sunrise && <span className="text-text-secondary">🌅 {briefing.sunrise}</span>}
          {briefing.sunset && <span className="text-text-secondary">🌇 {briefing.sunset}</span>}
        </div>
      )}
    </section>
  );
}

export function AviationPlanner() {
  const [dep, setDep] = useState<LocationResult | null>(null);
  const [dest, setDest] = useState<LocationResult | null>(null);
  const [alt, setAlt] = useState<LocationResult | null>(null);
  const [showAlt, setShowAlt] = useState(false);
  const [loading, setLoading] = useState(false);
  const [briefingData, setBriefingData] = useState<BriefingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);

  const depIcao = dep ? getIcaoForSlug(dep.slug) : null;
  const destIcao = dest ? getIcaoForSlug(dest.slug) : null;
  const altIcao = alt ? getIcaoForSlug(alt.slug) : null;
  const canBrief = !!depIcao && !!destIcao;

  const fetchAirport = async (slug: string, name: string, icao: string): Promise<AirportBriefing> => {
    const [metarRes, wxRes] = await Promise.allSettled([
      fetch(`/api/py/metar?icao=${icao}`),
      fetch(`/api/py/weather?location=${slug}`),
    ]);

    let metar: MetarObs[] = [];
    let taf: string | null = null;
    if (metarRes.status === "fulfilled" && metarRes.value.ok) {
      const d = await metarRes.value.json();
      metar = d.metar ?? [];
      taf = d.taf ?? null;
    }

    let sunrise: string | undefined;
    let sunset: string | undefined;
    if (wxRes.status === "fulfilled" && wxRes.value.ok) {
      const d = await wxRes.value.json();
      const daily = d.weather?.daily;
      if (daily?.sunrise?.[0]) {
        sunrise = new Date(daily.sunrise[0]).toLocaleTimeString("en-ZW", { hour: "2-digit", minute: "2-digit", hour12: false });
        sunset = new Date(daily.sunset[0]).toLocaleTimeString("en-ZW", { hour: "2-digit", minute: "2-digit", hour12: false });
      }
    }

    return { icao, name, metar, taf, sunrise, sunset };
  };

  const getBriefing = async () => {
    if (!dep || !dest || !depIcao || !destIcao) return;
    setLoading(true);
    setError(null);
    setBriefingData(null);
    try {
      const [departure, destination, alternate] = await Promise.all([
        fetchAirport(dep.slug, dep.name, depIcao),
        fetchAirport(dest.slug, dest.name, destIcao),
        alt && altIcao ? fetchAirport(alt.slug, alt.name, altIcao) : Promise.resolve(undefined),
      ]);
      setBriefingData({
        departure,
        destination,
        alternate,
        generatedAt: new Date().toLocaleString("en-ZW", {
          day: "2-digit", month: "short", year: "numeric",
          hour: "2-digit", minute: "2-digit", timeZoneName: "short",
        }),
      });
    } catch {
      setError("Failed to fetch briefing data. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const generatePdf = async () => {
    if (!briefingData) return;
    setPdfLoading(true);
    try {
      const { pdf } = await import("@react-pdf/renderer");
      const { AviationBriefingPDF } = await import("./AviationBriefingPDF");
      const blob = await pdf(<AviationBriefingPDF data={briefingData} />).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const dateStr = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `wx-briefing-${briefingData.departure.icao}-${briefingData.destination.icao}-${dateStr}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setError("PDF generation failed. Please try again.");
    } finally {
      setPdfLoading(false);
    }
  };

  return (
    <main id="main-content" className="mx-auto max-w-3xl px-4 py-6 pb-24 sm:px-6 sm:pb-8 md:px-8">
      <h1 className="text-2xl font-semibold text-text-primary font-heading mb-1">Aviation Weather Briefing</h1>
      <p className="text-sm text-text-secondary mb-6">Pre-flight weather for pilots. Select your departure and destination to get METAR, TAF, and generate a PDF briefing.</p>

      {/* Route selection */}
      <div className="rounded-[var(--radius-card)] border border-primary/20 bg-surface-card p-5 shadow-sm mb-6 space-y-4">
        <AirportSearch label="Departure Airport" value={dep} onChange={setDep} />
        <AirportSearch label="Destination Airport" value={dest} onChange={setDest} />

        {showAlt ? (
          <AirportSearch label="Alternate Airport (optional)" value={alt} onChange={setAlt} />
        ) : (
          <button type="button" onClick={() => setShowAlt(true)} className="text-sm text-primary hover:underline">
            + Add alternate airport
          </button>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={getBriefing}
            disabled={!canBrief || loading}
            className="press-scale inline-flex items-center gap-2 rounded-[var(--radius-button)] bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/90 hover:shadow-md disabled:opacity-40 disabled:cursor-not-allowed min-h-[var(--touch-target-min)]"
          >
            <NavigationIcon size={15} aria-hidden="true" />
            {loading ? "Loading…" : "Get Briefing"}
          </button>
          {!canBrief && dep && !depIcao && (
            <p className="text-xs text-severity-moderate">Departure has no METAR station</p>
          )}
          {!canBrief && dest && !destIcao && (
            <p className="text-xs text-severity-moderate">Destination has no METAR station</p>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-[var(--radius-card)] border border-severity-moderate/30 bg-severity-moderate/5 p-4 mb-6" role="alert">
          <p className="text-sm text-severity-moderate">{error}</p>
        </div>
      )}

      {/* Briefing results */}
      {briefingData && (
        <div className="space-y-6">
          {/* Route header + PDF button */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h2 className="text-lg font-semibold text-text-primary font-heading">
                <span className="font-mono text-primary">{briefingData.departure.icao}</span>
                <span className="mx-2 text-text-tertiary">→</span>
                <span className="font-mono text-primary">{briefingData.destination.icao}</span>
              </h2>
              <p className="text-xs text-text-tertiary mt-0.5">Briefing generated {briefingData.generatedAt}</p>
            </div>
            <button
              type="button"
              onClick={generatePdf}
              disabled={pdfLoading}
              className="press-scale inline-flex items-center gap-2 rounded-[var(--radius-button)] border border-primary/30 bg-surface-card px-4 py-2.5 text-sm font-medium text-primary transition-all hover:bg-primary/5 hover:border-primary/60 disabled:opacity-50 min-h-[var(--touch-target-min)]"
            >
              {pdfLoading ? "Generating…" : "↓ Download PDF Briefing"}
            </button>
          </div>

          {/* Flight conditions summary */}
          <div className="rounded-[var(--radius-card)] border border-primary/20 bg-surface-card p-4 shadow-sm">
            <h3 className="text-sm font-medium text-text-secondary mb-3">Flight Conditions at Briefing Time</h3>
            <div className="flex gap-6">
              <div className="text-center">
                <p className="text-xs text-text-tertiary mb-1">Departure</p>
                <p className="text-sm font-mono font-bold text-text-primary mb-1">{briefingData.departure.icao}</p>
                <FlightCategoryBadge fc={briefingData.departure.metar[0]?.flight_category ?? "N/A"} />
              </div>
              {briefingData.alternate && (
                <div className="text-center">
                  <p className="text-xs text-text-tertiary mb-1">Alternate</p>
                  <p className="text-sm font-mono font-bold text-text-primary mb-1">{briefingData.alternate.icao}</p>
                  <FlightCategoryBadge fc={briefingData.alternate.metar[0]?.flight_category ?? "N/A"} />
                </div>
              )}
              <div className="text-center">
                <p className="text-xs text-text-tertiary mb-1">Destination</p>
                <p className="text-sm font-mono font-bold text-text-primary mb-1">{briefingData.destination.icao}</p>
                <FlightCategoryBadge fc={briefingData.destination.metar[0]?.flight_category ?? "N/A"} />
              </div>
            </div>
          </div>

          {/* Airport briefings */}
          <AirportBriefingCard briefing={briefingData.departure} title="Departure" />
          <div className="border-t border-text-tertiary/10" />
          <AirportBriefingCard briefing={briefingData.destination} title="Destination" />
          {briefingData.alternate && (
            <>
              <div className="border-t border-text-tertiary/10" />
              <AirportBriefingCard briefing={briefingData.alternate} title="Alternate" />
            </>
          )}

          {/* Data source note */}
          <p className="text-xs text-text-tertiary text-center pb-4">
            METAR/TAF data from Aviation Weather Center (NOAA) · For planning purposes only
          </p>
        </div>
      )}
    </main>
  );
}
