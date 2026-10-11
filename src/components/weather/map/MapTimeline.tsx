"use client";

import { useMemo } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import type { TimelineFrame } from "@/lib/map-layers";
import { frameStops, type TimelineStop } from "@/lib/map-timeline";
import { useMziziHarness } from "@/lib/harness";
import { cn } from "@/lib/utils";

/** Icon size for every timeline control — matches the map's top controls. */
const ICON_CLASS = "h-5 w-5";

/**
 * Stops this close to the first keep their day tick but drop the weekday
 * label, which would otherwise collide with the first label on a phone-width
 * track (each 3-hour column is ~12px at 360px).
 */
export const MIN_LABEL_GAP_STEPS = 4;

/** The place's clock for a forward (forecast) timeline. */
export interface TimelineZone {
  /** The place's UTC offset, so every label is its wall clock. */
  offsetSeconds: number;
  /** The place's name, for "Harare time". */
  zoneName: string;
  /** True while the offset is only a longitude estimate. */
  approximate?: boolean;
  /** Minute-granular "now"; null until the client has a clock. */
  now: Date | null;
}

/** One tick (and maybe a label) on the tick row. */
function Tick({
  label,
  index,
  edge,
  primary,
}: {
  label: string;
  index: number;
  edge: "left" | "right";
  primary: boolean;
}) {
  const showLabel = primary || index >= MIN_LABEL_GAP_STEPS || edge === "right";
  const anchor = edge === "left" ? "left-0" : "right-0";
  return (
    <>
      <span
        className={cn(
          "absolute top-0 h-2 w-0.5 rounded-full",
          anchor,
          edge === "left" ? "-translate-x-1/2" : "translate-x-1/2",
          primary ? "bg-primary" : "bg-text-tertiary/50",
        )}
      />
      {showLabel && (
        <span
          className={cn(
            "absolute top-2 whitespace-nowrap",
            anchor,
            primary && "font-semibold text-primary",
            // Centred under its tick, except at the ends, where it would
            // overflow the sheet: the first hangs right, the last hangs left.
            !primary && edge === "left" && "-translate-x-1/2",
          )}
        >
          {label}
        </span>
      )}
    </>
  );
}

interface MapTimelineProps {
  /** The layer's frames (forecast, model or satellite), in order. */
  frames: readonly TimelineFrame[];
  step: number;
  playing: boolean;
  onStepChange: (step: number) => void;
  onPlayingChange: (playing: boolean) => void;
  /**
   * Forward timelines (rain, model fields) pass the place's clock and every
   * label becomes its local time. Observed loops (satellite) pass null and
   * keep each frame's own relative label ("−3h", "Yesterday").
   */
  zone: TimelineZone | null;
  /** Accessible name of the range input. */
  inputLabel?: string;
}

/**
 * Timeline scrubber for the map's bottom sheet: play/pause, step
 * back/forward, and a native range input (keyboard, touch and
 * aria-valuetext for free) restyled as `.springhare`. The first stop is
 * marked; on a forward timeline each new local day gets a tick and its
 * weekday. Every time shown is the PLACE's wall clock, never the viewer's.
 */
export function MapTimeline({
  frames,
  step,
  playing,
  onStepChange,
  onPlayingChange,
  zone,
  inputLabel = "Forecast time",
}: MapTimelineProps) {
  const { announce } = useMziziHarness("map-timeline");
  const stops = useMemo<TimelineStop[] | null>(
    () =>
      zone?.now
        ? frameStops(
            frames,
            zone.now,
            zone.offsetSeconds,
            zone.zoneName,
            zone.approximate,
          )
        : null,
    [frames, zone],
  );
  const last = Math.max(frames.length - 1, 0);
  const current = stops?.[step];
  const frame = frames[step];
  const valueText = current?.valueText ?? frame?.label ?? "";
  const readout = current
    ? step === 0 && current.time === "Now"
      ? `Now · ${current.day} ${current.clock}`
      : `${current.day} ${current.time}`
    : (frame?.label ?? "");
  const zoneLine = zone
    ? zone.approximate
      ? `≈ ${zone.zoneName} time`
      : `${zone.zoneName} time`
    : null;

  const go = (next: number) => {
    onPlayingChange(false);
    onStepChange(Math.min(last, Math.max(0, next)));
  };

  const togglePlay = () => {
    const next = !playing;
    onPlayingChange(next);
    announce(next ? "Playing the timeline" : `Paused at ${valueText}`);
  };

  // Tick row: forward timelines mark the first stop and each new local day;
  // observed loops mark the two ends with the frames' own labels.
  const tickAt = (i: number): { label: string; primary: boolean } | null => {
    if (stops) {
      if (i === 0) return { label: "Now", primary: true };
      return stops[i]?.dayStart
        ? { label: stops[i].day, primary: false }
        : null;
    }
    if (i === 0) return { label: frames[0]?.label ?? "", primary: true };
    return null;
  };
  const endTick =
    !stops && frames.length > 1
      ? { label: frames[last].label, primary: false }
      : stops?.[last]?.dayStart
        ? { label: stops[last].day, primary: false }
        : null;

  return (
    <div className="flex flex-col gap-1" data-slot="map-timeline">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={
            playing ? "Pause forecast timeline" : "Play forecast timeline"
          }
          className="duiker-solid"
        >
          {playing ? (
            <Pause className={ICON_CLASS} aria-hidden="true" />
          ) : (
            <Play
              className={cn(ICON_CLASS, "translate-x-px")}
              aria-hidden="true"
            />
          )}
        </button>
        <button
          type="button"
          onClick={() => go(step - 1)}
          disabled={step <= 0}
          aria-label="Earlier time"
          className="duiker"
        >
          <ChevronLeft className={ICON_CLASS} aria-hidden="true" />
        </button>
        <p
          className="min-w-0 flex-1 text-center"
          aria-live={playing ? "off" : "polite"}
        >
          <span className="block font-mono text-base font-semibold text-text-primary tabular-nums">
            {readout}
          </span>
          {zoneLine && (
            <span className="block text-sm text-text-tertiary">{zoneLine}</span>
          )}
        </p>
        <button
          type="button"
          onClick={() => go(step + 1)}
          disabled={step >= last}
          aria-label="Later time"
          className="duiker"
        >
          <ChevronRight className={ICON_CLASS} aria-hidden="true" />
        </button>
      </div>

      <input
        type="range"
        min={0}
        max={last}
        step={1}
        value={step}
        onChange={(e) => go(Number(e.target.value))}
        aria-label={inputLabel}
        aria-valuetext={valueText}
        className="springhare"
      />

      {/* Tick row under the track: one equal column per gap between frames
          (flex-1, so any frame count lines up with the range track); px-3 is
          half the 24px thumb, so a tick at a column edge sits under the
          thumb's centre. Column i draws frame i at its left edge; the last
          column also draws the final frame at its right edge. */}
      <div
        aria-hidden="true"
        className="-mt-2 flex h-8 px-3 text-sm text-text-tertiary"
      >
        {Array.from({ length: last }, (_, i) => {
          const t = tickAt(i);
          return (
            <span key={i} className="relative flex-1">
              {t && (
                <Tick
                  label={t.label}
                  index={i}
                  edge="left"
                  primary={t.primary}
                />
              )}
              {i === last - 1 && endTick && (
                <Tick
                  label={endTick.label}
                  index={last}
                  edge="right"
                  primary={false}
                />
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
