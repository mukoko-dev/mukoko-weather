"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";
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

/**
 * Location-aware haze panel (smoke, dust, urban smog, seasons, official PSI).
 *
 * Fetches `/api/py/haze` for the given coordinates. Renders a wide card only
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

type HazeState =
  | { status: "loading" }
  | { status: "ready"; data: HazeResponse }
  | { status: "error" };

export function HazePanel({ lat, lon }: Props) {
  const [state, setState] = useState<HazeState>({ status: "loading" });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    let cancelled = false;

    fetch(`/api/py/haze?lat=${lat}&lon=${lon}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as HazeResponse;
      })
      .then((json) => {
        if (cancelled) return;
        setState({ status: "ready", data: json });
      })
      .catch((err: unknown) => {
        if (
          cancelled ||
          (err as { name?: string } | null)?.name === "AbortError"
        )
          return;
        setState({ status: "error" });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [lat, lon]);

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
              className={`h-2 flex-1 rounded-full ${
                filled
                  ? hazeSeverityClasses(segmentLevel).fill
                  : "bg-surface-dim"
              }`}
            />
          );
        })}
      </div>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="rounded-card bg-surface-dim p-3">
          <dt className="dove">Visibility</dt>
          <dd className="text-base font-medium text-text-primary">
            {formatVisibility(data.visibilityKm)}
          </dd>
        </div>
        <div className="rounded-card bg-surface-dim p-3">
          <dt className="dove">PM2.5</dt>
          <dd className="text-base font-medium text-text-primary">
            {formatMicrograms(data.pm25)}
          </dd>
        </div>
        {showDust && (
          <div className="rounded-card bg-surface-dim p-3">
            <dt className="dove">Dust</dt>
            <dd className="text-base font-medium text-text-primary">
              {formatMicrograms(data.dust)}
            </dd>
          </div>
        )}
      </dl>

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
