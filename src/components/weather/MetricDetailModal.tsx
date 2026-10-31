"use client";

import { useMemo } from "react";
import type { WeatherData } from "@/lib/weather";
import {
  METRIC_CHART,
  metricDetail,
  metricSeries,
  type MetricExtras,
  type MetricKind,
  type MetricSeriesPoint,
} from "@/lib/metric-details";
import { resolveOffsetSeconds } from "@/lib/location-time";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogSheetHandle,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ChartErrorBoundary } from "./ChartErrorBoundary";
import { ChartSkeleton } from "@/components/ui/skeleton";
import { WindSpeedChart } from "./charts/WindSpeedChart";
import { UVIndexChart } from "./charts/UVIndexChart";
import { FeelsLikeChart } from "./charts/FeelsLikeChart";
import { VisibilityChart } from "./charts/VisibilityChart";
import { PrecipitationChart } from "./charts/PrecipitationChart";
import { HumidityChart } from "./charts/HumidityChart";
import { PressureChart } from "./charts/PressureChart";

interface Props {
  /** The tile that was opened; null keeps the modal closed. */
  kind: MetricKind | null;
  data: WeatherData;
  now: Date;
  extras?: MetricExtras;
  onClose: () => void;
}

type SeriesRow = MetricSeriesPoint[];

function MetricChart({
  chart,
  series,
}: {
  chart: NonNullable<(typeof METRIC_CHART)[MetricKind]>;
  series: SeriesRow;
}) {
  const common = { data: series, labelKey: "label", maxTicksLimit: 6 };
  switch (chart) {
    case "wind":
      return <WindSpeedChart {...common} />;
    case "uv":
      return <UVIndexChart {...common} />;
    case "feels":
      return <FeelsLikeChart {...common} />;
    case "visibility":
      return <VisibilityChart {...common} aspect="aspect-[16/8]" />;
    case "rain":
      return <PrecipitationChart {...common} aspect="aspect-[16/8]" />;
    case "humidity":
      return <HumidityChart {...common} />;
    case "pressure":
      return <PressureChart {...common} />;
  }
}

/**
 * The detail card behind a Conditions tile: the number, what it means, the next
 * 24 hours as a chart, the related readings and a plain explanation. A bottom
 * sheet on phones, a centred dialog from `sm` (the shared Dialog does both).
 */
export function MetricDetailModal({ kind, data, now, extras, onClose }: Props) {
  const detail = useMemo(
    () => (kind ? metricDetail(kind, data, now, extras) : null),
    [kind, data, now, extras],
  );
  const series = useMemo(
    () =>
      kind && METRIC_CHART[kind]
        ? metricSeries(
            data.hourly,
            resolveOffsetSeconds(data.utc_offset_seconds, now),
            now,
          )
        : [],
    [kind, data.hourly, data.utc_offset_seconds, now],
  );
  const chart = kind ? METRIC_CHART[kind] : null;

  return (
    <Dialog open={kind !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby="metric-detail-about" className="pb-6">
        <DialogSheetHandle />
        {detail && (
          <div className="flex flex-col gap-[var(--space-section)] px-4 pt-3 sm:px-5">
            <header className="flex flex-col gap-1">
              <DialogTitle className="hornbill text-sm">
                {detail.title}
              </DialogTitle>
              <p className="font-heading text-4xl font-semibold leading-none tabular-nums text-text-primary">
                {detail.headline}
              </p>
              <p className="gazelle">{detail.sentence}</p>
            </header>

            {chart && series.length > 1 && (
              <section aria-label={`${detail.title}, next 24 hours`}>
                <h3 className="giraffe mb-[var(--space-stack)]">
                  Next 24 hours
                </h3>
                <ChartErrorBoundary name={`${detail.title} chart`}>
                  <MetricChart chart={chart} series={series} />
                </ChartErrorBoundary>
              </section>
            )}
            {chart && series.length <= 1 && <ChartSkeleton />}

            {detail.stats.length > 0 && (
              <dl className="grid grid-cols-2 gap-[var(--space-stack)]">
                {detail.stats.map((s) => (
                  <div key={s.label} className="meerkat">
                    <dt className="dove">{s.label}</dt>
                    <dd className="font-medium text-text-primary">{s.value}</dd>
                  </div>
                ))}
              </dl>
            )}

            <DialogDescription id="metric-detail-about">
              {detail.about}
            </DialogDescription>

            <DialogClose asChild>
              <Button variant="outline" className="w-full">
                Close
              </Button>
            </DialogClose>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
