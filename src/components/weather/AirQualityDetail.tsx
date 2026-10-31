"use client";

import Link from "next/link";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogSheetHandle,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AQI_BAND_LABELS, aqiBand } from "@/lib/aq-grid";
import {
  AQI_RANGES,
  aqiScalePct,
  freshnessLabel,
  guidanceFor,
  pollutantRows,
  type AirQualityReading,
} from "@/lib/air-quality-details";
import { AIR_QUALITY_LAYER_ID, writeStoredMapLayer } from "@/lib/map-layers";
import { GradientScale } from "./widgets";

interface Props {
  open: boolean;
  reading: AirQualityReading;
  /** The place's slug; the map link is hidden without one. */
  slug?: string;
  now: Date;
  onClose: () => void;
}

function rememberAirQualityLayer() {
  try {
    writeStoredMapLayer(window.localStorage, AIR_QUALITY_LAYER_ID);
  } catch {
    // Blocked storage: the map opens on its own default layer.
  }
}

/**
 * The detail behind the Air quality card: the index on the EPA scale, plain
 * guidance, every pollutant (the main one first) and how fresh the reading is.
 * Colour is never the only signal: each band has its name and range printed.
 */
export function AirQualityDetail({ open, reading, slug, now, onClose }: Props) {
  const band = aqiBand(reading.aqi);
  const guidance = guidanceFor(reading);
  const rows = pollutantRows(reading);
  const updated = freshnessLabel(reading.fetchedAt, now.getTime());

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent aria-describedby="air-quality-guidance" className="pb-6">
        <DialogSheetHandle />
        <div className="flex flex-col gap-[var(--space-section)] px-4 pt-3 sm:px-5">
          <header className="flex flex-col gap-1">
            <DialogTitle className="hornbill text-sm">Air quality</DialogTitle>
            <p className="font-heading text-4xl font-semibold leading-none tabular-nums text-text-primary">
              {reading.aqi}{" "}
              <span className="giraffe">{AQI_BAND_LABELS[band]}</span>
            </p>
            <p className="dove">US EPA Air Quality Index, 0 to 500</p>
          </header>

          <section aria-label="Where the index sits on the scale">
            <GradientScale
              positionPct={aqiScalePct(reading.aqi)}
              stops="aqi"
              label={`US AQI ${reading.aqi}, ${AQI_BAND_LABELS[band]}`}
            />
            <ul className="mt-[var(--space-stack)] grid grid-cols-2 gap-x-3 gap-y-1 text-sm text-text-secondary">
              {AQI_RANGES.map(({ band: b, range }) => (
                <li
                  key={b}
                  aria-current={b === band ? "true" : undefined}
                  className={
                    b === band ? "font-medium text-text-primary" : undefined
                  }
                >
                  {AQI_BAND_LABELS[b]}{" "}
                  <span className="tabular-nums">{range}</span>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="aq-guidance-heading">
            <h3 id="aq-guidance-heading" className="giraffe mb-1">
              What it means for you
            </h3>
            <DialogDescription id="air-quality-guidance" className="gazelle">
              {guidance.text}
            </DialogDescription>
            <p className="dove mt-2">{guidance.disclaimer}</p>
          </section>

          <section aria-labelledby="aq-pollutants-heading">
            <h3
              id="aq-pollutants-heading"
              className="giraffe mb-[var(--space-stack)]"
            >
              Pollutants
            </h3>
            <ul className="flex flex-col">
              {rows.map((r) => (
                <li
                  key={r.key}
                  className="flex items-start justify-between gap-3 border-t border-border py-2.5 first:border-t-0"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-text-primary">
                      {r.symbol}{" "}
                      <span className="font-normal text-text-secondary">
                        {r.name}
                      </span>
                      {r.isMain && (
                        <span className="ml-2 rounded-[var(--radius-sm)] bg-surface-dim px-1.5 py-0.5 text-xs font-medium text-text-primary">
                          Main pollutant
                        </span>
                      )}
                    </p>
                    {r.who && <p className="dove">{r.who}</p>}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="tabular-nums text-text-primary">
                      {r.valueText ?? "No data"}
                    </p>
                    {r.subIndex !== null && (
                      <p className="dove tabular-nums">Index {r.subIndex}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <p className="dove mt-2">
              WHO 2021 guidelines are 24-hour values; these are current
              readings, so the comparison is a guide only.
            </p>
          </section>

          <p className="dove">
            {[reading.source ? `Source: ${reading.source}` : null, updated]
              .filter(Boolean)
              .join(" · ")}
          </p>

          {slug && (
            <Link
              href={`/${slug}/map`}
              onClick={rememberAirQualityLayer}
              className="impala w-full text-center"
            >
              See air quality on the map
            </Link>
          )}

          <DialogClose asChild>
            <Button variant="outline" className="w-full">
              Close
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
