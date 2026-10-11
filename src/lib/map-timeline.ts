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
import { TIMELINE_STEPS, TIMELINE_STEP_HOURS } from "@/lib/map-layers";
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

/** The instant a timeline step shows: floored UTC hour + step × 3 h. */
export function stopInstantMs(
  step: number,
  now: Date,
  stepHours: number = TIMELINE_STEP_HOURS,
): number {
  if (step <= 0) return now.getTime();
  const base = new Date(now.getTime());
  base.setUTCMinutes(0, 0, 0);
  return base.getTime() + step * stepHours * HOUR_MS;
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
 * place's name for the screen-reader text ("Harare time").
 */
export function timelineStops(
  now: Date,
  offsetSeconds: number,
  zoneName: string,
  steps: number = TIMELINE_STEPS,
  stepHours: number = TIMELINE_STEP_HOURS,
): TimelineStop[] {
  const offsetMs = offsetSeconds * 1000;
  const stops: TimelineStop[] = [];
  let prevDate = "";
  for (let step = 0; step < steps; step++) {
    const wall = stopInstantMs(step, now, stepHours) + offsetMs;
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
          ? `Now, ${LONG_DAYS[weekday]} ${clock} ${zoneName} time`
          : `${LONG_DAYS[weekday]} ${clock} ${zoneName} time, ${inHours(hoursAhead)}`,
    });
  }
  return stops;
}
