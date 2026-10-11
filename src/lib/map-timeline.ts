/**
 * Map timeline stops, labelled in the LOCATION's time zone.
 *
 * The map's timelines step through frames built in map-layers.ts
 * (`forecastTimelineFrames` for rain, `modelTimelineFrames` for model fields,
 * both forward in time). A visitor in Toronto looking at Harare must read
 * those stops as Harare wall-clock times, never their own clock, so every
 * label here is computed from the place's UTC offset with UTC getters (same
 * rule as src/lib/location-time.ts). The instant of a frame is read back from
 * the frame's own `timestamp` — the value the layer is drawn for — so a label
 * can never name a different frame from the one on screen.
 *
 * Observed layers (NASA satellite loops) are in the past and keep the frame's
 * own relative label; they do not go through here.
 */
import type { TimelineFrame } from "@/lib/map-layers";
import { wallClockLabel, wallDateString } from "@/lib/location-time";

const HOUR_MS = 3_600_000;
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export interface TimelineStop {
  /** Frame index. */
  step: number;
  /** Whole hours ahead of now (0 for the first stop). */
  hoursAhead: number;
  /** "Now", or the place's wall clock "HH:MM". */
  time: string;
  /** The place's wall clock "HH:MM" (also for the Now stop). */
  clock: string;
  /** Short weekday at the place, e.g. "Sat". */
  day: string;
  /** True for the first stop of a new local calendar day (not the first). */
  dayStart: boolean;
  /** Screen-reader text, e.g. "Saturday 15:00 Harare time, in 9 hours". */
  valueText: string;
}

/** The instant a frame is drawn for: "now" is now, else its ISO timestamp. */
export function frameInstantMs(frame: TimelineFrame, now: Date): number {
  if (frame.timestamp === "now") return now.getTime();
  const t = Date.parse(frame.timestamp);
  return Number.isFinite(t) ? t : now.getTime();
}

function inHours(hours: number): string {
  if (hours <= 0) return "now";
  if (hours < 24) return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  const d = `${days} ${days === 1 ? "day" : "days"}`;
  return rest === 0 ? `in ${d}` : `in ${d} ${rest} h`;
}

/**
 * Every stop of a forward timeline, labelled at the place. `zoneName` is the
 * place's name for the screen-reader text ("Harare time"); `approximate`
 * marks an offset that is only a longitude estimate.
 */
export function frameStops(
  frames: readonly TimelineFrame[],
  now: Date,
  offsetSeconds: number,
  zoneName: string,
  approximate: boolean = false,
): TimelineStop[] {
  const zone = approximate
    ? `${zoneName} time (approximate)`
    : `${zoneName} time`;
  const offsetMs = offsetSeconds * 1000;
  // "in N hours" counts from the current UTC hour, as the frames do (a +3h
  // frame is three whole hours on, however far into the hour it is now).
  const hourStart = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  const stops: TimelineStop[] = [];
  let prevDate = "";
  frames.forEach((frame, step) => {
    const instant = frameInstantMs(frame, now);
    const wall = instant + offsetMs;
    const date = wallDateString(wall);
    const weekday = new Date(wall).getUTCDay();
    const clock = wallClockLabel(wall);
    const isNow = step === 0 && frame.label === "Now";
    const hoursAhead = Math.max(0, Math.round((instant - hourStart) / HOUR_MS));
    const dayStart = step > 0 && date !== prevDate;
    prevDate = date;
    stops.push({
      step,
      hoursAhead,
      time: isNow ? "Now" : clock,
      clock,
      day: SHORT_DAYS[weekday],
      dayStart,
      valueText: isNow
        ? `Now, ${LONG_DAYS[weekday]} ${clock} ${zone}`
        : `${LONG_DAYS[weekday]} ${clock} ${zone}, ${inHours(hoursAhead)}`,
    });
  });
  return stops;
}

/** The place's UTC offset as our weather API reports it. */
export interface PlaceOffset {
  offsetSeconds: number;
  /** True when the API itself only estimated it (from longitude). */
  estimated: boolean;
}

/**
 * Reads the place's real (DST-aware) UTC offset from our cached
 * `/api/py/weather` — the same row the location page already filled, so a
 * visit from there costs a cache hit. Null on any failure; the caller keeps
 * its estimate. Never calls a provider directly.
 */
export async function fetchPlaceOffset(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<PlaceOffset | null> {
  try {
    const res = await fetch(`/api/py/weather?lat=${lat}&lon=${lon}`, {
      signal,
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (!data || typeof data !== "object") return null;
    const { utc_offset_seconds: offset, utc_offset_estimated: estimated } =
      data as { utc_offset_seconds?: unknown; utc_offset_estimated?: unknown };
    if (typeof offset !== "number" || !Number.isFinite(offset)) return null;
    return { offsetSeconds: offset, estimated: estimated === true };
  } catch {
    return null;
  }
}
