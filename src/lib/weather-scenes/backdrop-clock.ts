import {
  locationDateString,
  nowWallClockMs,
  wallClockMs,
  wallNaiveIso,
  weatherOffsetSeconds,
  type HasUtcOffset,
} from "@/lib/location-time";
import { resolveUtcOffsetSeconds } from "@/lib/location-card";

/**
 * The location's clock for the sky backdrop's dawn/dusk phase.
 *
 * `skyPhase()` (palette.ts) compares "HH:MM" from three ISO strings, so all
 * three must be in the SAME frame — the LOCATION's wall clock, never the
 * viewer's. Providers mix naive local strings (Open-Meteo) and zoned
 * instants (Tomorrow.io: "…T03:50:00Z"), so every value is normalised here
 * to a naive "YYYY-MM-DDTHH:MM" local string via src/lib/location-time.ts.
 * "Now" comes from the live clock shifted by the location's UTC offset, so
 * a cached payload still tracks real time.
 *
 * Offset: the payload's `utc_offset_seconds`; when a payload lacks it (an
 * older cache row or provider), the place's country/longitude estimate
 * (`resolveUtcOffsetSeconds`) — still the location's clock, never the
 * viewer's.
 */
export interface BackdropClock {
  currentTime: string;
  sunrise?: string;
  sunset?: string;
}

interface DailySun {
  time?: readonly string[];
  sunrise?: readonly string[];
  sunset?: readonly string[];
}

export function backdropClock(
  weather: HasUtcOffset & { daily?: DailySun | null },
  place?: { lon: number; country?: string | null } | null,
  now: Date = new Date(),
): BackdropClock {
  const offset = place
    ? resolveUtcOffsetSeconds(
        weather.utc_offset_seconds,
        place.lon,
        place.country,
      )
    : weatherOffsetSeconds(weather, now);
  const currentTime = wallNaiveIso(nowWallClockMs(offset, now));

  // Today's sunrise/sunset at the location (fall back to the first day).
  const today = locationDateString(offset, now);
  const daily = weather.daily;
  let idx = daily?.time?.findIndex((t) => {
    const k = wallClockMs(t, offset);
    return k !== null && wallNaiveIso(k).slice(0, 10) === today;
  });
  if (idx === undefined || idx < 0) idx = 0;

  const local = (iso: string | undefined) => {
    const k = wallClockMs(iso, offset);
    return k === null ? undefined : wallNaiveIso(k);
  };
  return {
    currentTime,
    sunrise: local(daily?.sunrise?.[idx]),
    sunset: local(daily?.sunset?.[idx]),
  };
}
