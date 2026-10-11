/**
 * Map timeline stops, labelled in the LOCATION's time zone.
 *
 * The map's rain timeline steps through Tomorrow.io tile timestamps
 * (`timelineTimestamp` in map-layers.ts: step 0 is "now", step n is the
 * current UTC hour + n × 3 h). A visitor in Toronto looking at Harare must
 * read those stops as Harare wall-clock times, never their own clock, so
 * every label here is computed from the place's UTC offset with UTC getters
 * (same rule as src/lib/location-time.ts).
 */
import {
  TIMELINE_STEPS,
  TIMELINE_STEP_HOURS,
  timelineTimestamp,
} from "@/lib/map-layers";
import { wallClockLabel, wallDateString } from "@/lib/location-time";

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
  step: number;
  /** Hours ahead of now (0 for the first stop). */
  hoursAhead: number;
  /** "Now", or the place's wall clock "HH:MM". */
  time: string;
  /** The place's wall clock "HH:MM" (also for step 0). */
  clock: string;
  /** Short weekday at the place, e.g. "Sat". */
  day: string;
  /** True for the first stop of a new local calendar day (not step 0). */
  dayStart: boolean;
  /** Screen-reader text, e.g. "Saturday 15:00 Harare time, in 9 hours". */
  valueText: string;
}

/**
 * The instant a timeline step shows. Read back from `timelineTimestamp`, the
 * function that builds the tile URL, so a label can never name a different
 * frame from the one drawn.
 */
export function stopInstantMs(step: number, now: Date): number {
  if (step <= 0) return now.getTime();
  return Date.parse(timelineTimestamp(step, now));
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
 * Every stop of the timeline, labelled at the place. `zoneName` is the
 * place's name for the screen-reader text ("Harare time"); `approximate`
 * marks an offset that is only a longitude estimate.
 */
export function timelineStops(
  now: Date,
  offsetSeconds: number,
  zoneName: string,
  approximate: boolean = false,
  steps: number = TIMELINE_STEPS,
  stepHours: number = TIMELINE_STEP_HOURS,
): TimelineStop[] {
  const zone = approximate
    ? `${zoneName} time (approximate)`
    : `${zoneName} time`;
  const offsetMs = offsetSeconds * 1000;
  const stops: TimelineStop[] = [];
  let prevDate = "";
  for (let step = 0; step < steps; step++) {
    const wall = stopInstantMs(step, now) + offsetMs;
    const date = wallDateString(wall);
    const weekday = new Date(wall).getUTCDay();
    const clock = wallClockLabel(wall);
    const hoursAhead = step * stepHours;
    const dayStart = step > 0 && date !== prevDate;
    prevDate = date;
    stops.push({
      step,
      hoursAhead,
      time: step === 0 ? "Now" : clock,
      clock,
      day: SHORT_DAYS[weekday],
      dayStart,
      valueText:
        step === 0
          ? `Now, ${LONG_DAYS[weekday]} ${clock} ${zone}`
          : `${LONG_DAYS[weekday]} ${clock} ${zone}, ${inHours(hoursAhead)}`,
    });
  }
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
