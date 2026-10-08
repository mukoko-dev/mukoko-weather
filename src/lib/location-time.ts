/**
 * Location time — every "current hour" and every hour label is read in the
 * LOCATION's time zone, never the viewer's clock and never the server's (UTC).
 *
 * mukoko weather is used from anywhere: a farmer's daughter in Perth checks
 * Harare, a trader in Toronto checks Singapore. The forecast arrives as
 * either
 *
 *   - naive local wall-clock strings (Open-Meteo `timezone=auto`:
 *     "2026-10-08T14:00"), or
 *   - zoned instants (Tomorrow.io / seasonal fallback / StationKit:
 *     "2026-10-08T12:00:00Z", "…+00:00"),
 *
 * plus the location's `utc_offset_seconds`. Parsing either with `new Date()`
 * and reading `getHours()` answers in the viewer's zone, which is the bug
 * this module exists to prevent. Everything here is pure arithmetic on UTC
 * getters, so it is deterministic in tests whatever `TZ` the runner has.
 *
 * Two frames:
 *   - **instant** — real epoch ms (what `Date.now()` returns)
 *   - **wall** — the location's wall clock encoded as if it were UTC
 *     (`wall = instant + offset`), read back with `getUTC*`.
 */

const HOUR_MS = 3_600_000;
const NAIVE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;
/** A trailing zone designator: Z, ±HH:MM, ±HHMM or ±HH. */
const ZONE_RE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

/** Something that may carry the location's UTC offset (a WeatherData). */
export interface HasUtcOffset {
  utc_offset_seconds?: number | null;
}

/** The viewer's own UTC offset — only a last-resort fallback. */
export function viewerOffsetSeconds(now: Date = new Date()): number {
  return -now.getTimezoneOffset() * 60;
}

/**
 * The offset to read a forecast with. A finite `offset` (the location's,
 * from the weather payload) always wins; without one we fall back to the
 * viewer's clock — the pre-fix behaviour, kept only so a payload cached
 * before the backend guaranteed the field still renders.
 */
export function resolveOffsetSeconds(
  offset: number | null | undefined,
  now: Date = new Date(),
): number {
  return typeof offset === "number" && Number.isFinite(offset)
    ? offset
    : viewerOffsetSeconds(now);
}

/** Offset for a weather payload (see `resolveOffsetSeconds`). */
export function weatherOffsetSeconds(
  weather: HasUtcOffset | null | undefined,
  now: Date = new Date(),
): number {
  return resolveOffsetSeconds(weather?.utc_offset_seconds, now);
}

/** True when the string carries its own zone (Z or ±HH:MM). */
export function hasZone(iso: string): boolean {
  return /T|\s/.test(iso) && ZONE_RE.test(iso.trim());
}

/**
 * The location's wall clock for an ISO string, as ms-if-UTC. Naive strings
 * are already local wall time; zoned strings are shifted by the offset.
 * Returns null for anything unparseable.
 */
export function wallClockMs(
  iso: string | null | undefined,
  offsetSeconds: number,
): number | null {
  if (typeof iso !== "string" || !iso) return null;
  if (hasZone(iso)) {
    const instant = Date.parse(iso);
    return Number.isFinite(instant) ? instant + offsetSeconds * 1000 : null;
  }
  const m = NAIVE_RE.exec(iso);
  if (!m) return null;
  return Date.UTC(
    +m[1],
    +m[2] - 1,
    +m[3],
    m[4] ? +m[4] : 0,
    m[5] ? +m[5] : 0,
    m[6] ? +m[6] : 0,
  );
}

/** The real epoch ms an ISO string names, given the location's offset. */
export function instantMs(
  iso: string | null | undefined,
  offsetSeconds: number,
): number | null {
  const wall = wallClockMs(iso, offsetSeconds);
  return wall === null ? null : wall - offsetSeconds * 1000;
}

/** The location's wall clock right now, as ms-if-UTC. */
export function nowWallClockMs(
  offsetSeconds: number,
  now: Date = new Date(),
): number {
  return now.getTime() + offsetSeconds * 1000;
}

/** Start of the location's current hour, as wall ms-if-UTC. */
export function currentWallHourMs(
  offsetSeconds: number,
  now: Date = new Date(),
): number {
  return Math.floor(nowWallClockMs(offsetSeconds, now) / HOUR_MS) * HOUR_MS;
}

/**
 * Index of the location's current hour in an hourly series: the first slot
 * at or after the start of the current local hour. 0 when the series does
 * not reach that far (a stale payload) so callers still render something.
 */
export function currentHourIndex(
  times: readonly string[] | undefined,
  offsetSeconds: number,
  now: Date = new Date(),
): number {
  if (!times?.length) return 0;
  const hourStart = currentWallHourMs(offsetSeconds, now);
  const idx = times.findIndex((t) => {
    const k = wallClockMs(t, offsetSeconds);
    return k !== null && k >= hourStart;
  });
  return idx >= 0 ? idx : 0;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "HH:MM" for a wall ms-if-UTC value. */
export function wallClockLabel(wallMs: number): string {
  const d = new Date(wallMs);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** "HH:00" for a wall ms-if-UTC value. */
export function wallHourLabel(wallMs: number): string {
  return `${pad2(new Date(wallMs).getUTCHours())}:00`;
}

/** "YYYY-MM-DD" for a wall ms-if-UTC value. */
export function wallDateString(wallMs: number): string {
  const d = new Date(wallMs);
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Local "HH:00" at the location for an ISO string ("" if unparseable). */
export function locationHourLabel(
  iso: string | null | undefined,
  offsetSeconds: number,
): string {
  const k = wallClockMs(iso, offsetSeconds);
  return k === null ? "" : wallHourLabel(k);
}

/** Local "HH:MM" at the location for an ISO string ("" if unparseable). */
export function locationClockLabel(
  iso: string | null | undefined,
  offsetSeconds: number,
): string {
  const k = wallClockMs(iso, offsetSeconds);
  return k === null ? "" : wallClockLabel(k);
}

/** Local hour of day (0–23) at the location for an ISO string, or null. */
export function locationHourOf(
  iso: string | null | undefined,
  offsetSeconds: number,
): number | null {
  const k = wallClockMs(iso, offsetSeconds);
  return k === null ? null : new Date(k).getUTCHours();
}

/** The location's calendar date right now, "YYYY-MM-DD". */
export function locationDateString(
  offsetSeconds: number,
  now: Date = new Date(),
): string {
  return wallDateString(nowWallClockMs(offsetSeconds, now));
}

/** The location's hour of day (0–23) right now. */
export function locationHourNow(
  offsetSeconds: number,
  now: Date = new Date(),
): number {
  return new Date(nowWallClockMs(offsetSeconds, now)).getUTCHours();
}

/**
 * Solar-meridian estimate of a UTC offset from longitude (15° per hour,
 * rounded to the quarter hour). Only for paths with no provider offset at
 * all — the seasonal fallback. `location-card.resolveUtcOffsetSeconds` adds
 * a fixed-offset country table on top of the same estimate.
 */
export function longitudeOffsetSeconds(lon: number): number {
  if (!Number.isFinite(lon)) return 0;
  return Math.round((lon / 15) * 4) * 900;
}

/** "YYYY-MM-DDTHH:MM" naive local string for a wall ms-if-UTC value. */
export function wallNaiveIso(wallMs: number): string {
  return new Date(wallMs).toISOString().slice(0, 16);
}
