"use client";

import { useMemo } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { TIMELINE_STEPS } from "@/lib/map-layers";
import { timelineStops, type TimelineStop } from "@/lib/map-timeline";
import { useMziziHarness } from "@/lib/harness";
import { cn } from "@/lib/utils";

/** Icon size for every timeline control — matches the map's top controls. */
const ICON_CLASS = "h-5 w-5";

/**
 * Stops this close to Now keep their day tick but drop the weekday label,
 * which would otherwise collide with the "Now" label on a phone-width track
 * (each 3-hour column is ~12px at 360px).
 */
export const MIN_LABEL_GAP_STEPS = 4;

/** One tick (and maybe a label) on the tick row. */
function Tick({
  stop,
  index,
  edge,
}: {
  stop: TimelineStop | undefined;
  index: number;
  edge: "left" | "right";
}) {
  const isNow = index === 0;
  if (!isNow && !stop?.dayStart) return null;
  const showLabel = isNow || index >= MIN_LABEL_GAP_STEPS;
  const anchor = edge === "left" ? "left-0" : "right-0";
  return (
    <>
      <span
        className={cn(
          "absolute top-0 h-2 w-0.5 rounded-full",
          anchor,
          edge === "left" ? "-translate-x-1/2" : "translate-x-1/2",
          isNow ? "bg-primary" : "bg-text-tertiary/50",
        )}
      />
      {showLabel && (
        <span
          className={cn(
            "absolute top-2 whitespace-nowrap",
            anchor,
            isNow && "font-semibold text-primary",
            // Centred under its tick, except at the very ends where it
            // would overflow the sheet: Now hangs right, the last hangs left.
            !isNow && edge === "left" && "-translate-x-1/2",
          )}
        >
          {isNow ? "Now" : stop?.day}
        </span>
      )}
    </>
  );
}

interface MapTimelineProps {
  step: number;
  playing: boolean;
  onStepChange: (step: number) => void;
  onPlayingChange: (playing: boolean) => void;
  /** The place's UTC offset, so every label is its wall clock. */
  offsetSeconds: number;
  /** The place's name, for "Harare time". */
  zoneName: string;
  /** True while the offset is only a longitude estimate. */
  approximate?: boolean;
  /** Minute-granular "now"; null until the client has a clock. */
  now: Date | null;
}

/**
 * Forecast timeline scrubber for the map's bottom sheet: play/pause, step
 * back/forward, and a native range input (keyboard, touch and
 * aria-valuetext for free) restyled as `.springhare`. The current time is
 * the marked first stop; each new local day gets a tick and its weekday.
 * Every time shown is the PLACE's wall clock, never the viewer's.
 */
export function MapTimeline({
  step,
  playing,
  onStepChange,
  onPlayingChange,
  offsetSeconds,
  zoneName,
  approximate = false,
  now,
}: MapTimelineProps) {
  const { announce } = useMziziHarness("map-timeline");
  const stops = useMemo(
    () =>
      now ? timelineStops(now, offsetSeconds, zoneName, approximate) : null,
    [now, offsetSeconds, zoneName, approximate],
  );
  const last = TIMELINE_STEPS - 1;
  const current = stops?.[step];

  const go = (next: number) => {
    onPlayingChange(false);
    onStepChange(Math.min(last, Math.max(0, next)));
  };

  const togglePlay = () => {
    const next = !playing;
    onPlayingChange(next);
    announce(
      next
        ? "Playing the rain forecast"
        : `Paused at ${current?.valueText ?? "the current time"}`,
    );
  };

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
          aria-label="Earlier forecast time"
          className="duiker"
        >
          <ChevronLeft className={ICON_CLASS} aria-hidden="true" />
        </button>
        <p
          className="min-w-0 flex-1 text-center"
          aria-live={playing ? "off" : "polite"}
        >
          <span className="block font-mono text-base font-semibold text-text-primary tabular-nums">
            {current
              ? step === 0
                ? `Now · ${current.day} ${current.clock}`
                : `${current.day} ${current.time}`
              : "Now"}
          </span>
          <span className="block text-sm text-text-tertiary">
            {approximate ? `≈ ${zoneName} time` : `${zoneName} time`}
          </span>
        </p>
        <button
          type="button"
          onClick={() => go(step + 1)}
          disabled={step >= last}
          aria-label="Later forecast time"
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
        aria-label="Forecast time"
        aria-valuetext={current?.valueText ?? "Now"}
        className="springhare"
      />

      {/* Tick row under the track. 24 columns = the 24 gaps between the 25
          stops (TIMELINE_STEPS, pinned by a test); px-3 is half the 24px
          thumb, so a tick at a column edge sits under the thumb's centre.
          Column i draws stop i at its left edge; the last column also draws
          the final stop at its right edge. */}
      <div
        aria-hidden="true"
        className="-mt-2 grid h-8 grid-cols-[repeat(24,minmax(0,1fr))] px-3 text-sm text-text-tertiary"
      >
        {Array.from({ length: last }, (_, i) => (
          <span key={i} className="relative">
            <Tick stop={stops?.[i]} index={i} edge="left" />
            {i === last - 1 && (
              <Tick stop={stops?.[last]} index={last} edge="right" />
            )}
          </span>
        ))}
      </div>
    </div>
  );
}
