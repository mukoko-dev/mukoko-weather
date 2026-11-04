"use client";

import { useWorkerData } from "@/lib/use-worker-data";
import type { ComponentType } from "react";
import {
  CloudIcon,
  CloudFogIcon,
  FactoryIcon,
  SunIcon,
  WindIcon,
} from "@/lib/weather-icons";
import {
  HAZE_LEVEL_LABELS,
  HAZE_LEVEL_ORDER,
  HAZE_TYPE_ICON,
  HAZE_TYPE_LABELS,
  formatMicrograms,
  formatMonthSpan,
  formatOfficialLine,
  formatPeakTime,
  formatVisibility,
  hazeLevelRank,
  hazeSeverityClasses,
  isHazeWorthShowing,
  type HazeIconKey,
  type HazeLevel,
  type HazeResponse,
} from "@/lib/haze";
import { StatGrid } from "./StatGrid";

/**
 * Location-aware haze panel (smoke, dust, urban smog, seasons, official PSI).
 *
 * Fetches the Worker's `/v1/haze` for the given coordinates. Renders a wide card only
 * when there is haze, or an active haze season with elevated readings —
 * otherwise nothing at all (no empty card). Failures render nothing.
 */

interface Props {
  lat: number;
  lon: number;
}

type IconComponent = ComponentType<{ className?: string; size?: number }>;

const ICON_COMPONENTS: Record<HazeIconKey, IconComponent> = {
  sun: SunIcon,
  cloud: CloudIcon,
  wind: WindIcon,
  factory: FactoryIcon,
  fog: CloudFogIcon,
};

export function HazePanel({ lat, lon }: Props) {
  // Shared read: one `/v1/haze` per 0.05 degree cell, however often this
  // section is mounted and unmounted by LazySection.
  const state = useWorkerData<HazeResponse>("haze", { lat, lon });

  if (state.status === "loading") {
    return (
      <div
        role="status"
        aria-label="Loading"
        className="chameleon min-h-32 w-full"
      >
        <span className="sr-only">Loading</span>
      </div>
    );
  }

  if (state.status === "error") return null;

  const data = state.data;
  if (!data.available || !data.level || !data.type) return null;
  if (!isHazeWorthShowing(data.level, data.type, data.season)) return null;

  const level: HazeLevel = data.level;
  const severity = hazeSeverityClasses(level);
  const TypeIcon = ICON_COMPONENTS[HAZE_TYPE_ICON[data.type]];
  const peak = formatPeakTime(data.peakTime);
  const showDust =
    data.type === "dust" || (data.dust !== null && data.dust >= 10);
  const levelRank = hazeLevelRank(level);

  return (
    <section
      aria-labelledby="haze-panel-heading"
      className="baobab mb-[var(--space-stack)] w-full space-y-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="dove uppercase tracking-wider">Haze</p>
          <h2 id="haze-panel-heading" className="giraffe">
            {data.headline}
          </h2>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium ${severity.soft} ${severity.text}`}
        >
          <span
            aria-hidden="true"
            className={`size-2.5 shrink-0 rounded-full ring-1 ring-wx-outline ${severity.fill}`}
          />
          <span aria-hidden="true">
            <TypeIcon size={14} />
          </span>
          {HAZE_TYPE_LABELS[data.type]}
          <span className="sr-only">, {HAZE_LEVEL_LABELS[level]} level</span>
        </span>
      </header>

      <div aria-hidden="true" className="flex gap-1">
        {HAZE_LEVEL_ORDER.slice(1).map((segmentLevel) => {
          const filled = levelRank >= hazeLevelRank(segmentLevel);
          return (
            <span
              key={segmentLevel}
              className={`h-2 flex-1 rounded-full ring-1 ring-wx-outline ${
                filled
                  ? hazeSeverityClasses(segmentLevel).fill
                  : "bg-surface-dim"
              }`}
            />
          );
        })}
      </div>

      <StatGrid
        columns={3}
        items={[
          { label: "Visibility", value: formatVisibility(data.visibilityKm) },
          { label: "PM2.5", value: formatMicrograms(data.pm25) },
          ...(showDust
            ? [{ label: "Dust", value: formatMicrograms(data.dust) }]
            : []),
        ]}
      />

      {peak && <p className="gazelle">Worst around {peak}</p>}

      {data.season && (
        <p className="dove">
          {data.season.name} · {formatMonthSpan(data.season.typicalMonths)}
          {data.season.active ? "" : " (out of season now)"}
        </p>
      )}

      {data.official && (
        <p className="dove">{formatOfficialLine(data.official)}</p>
      )}

      {data.advice.length > 0 && (
        <ul className="gazelle list-disc space-y-1 pl-5">
          {data.advice.slice(0, 3).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}

      <p className="dove">{data.attribution}</p>
    </section>
  );
}
