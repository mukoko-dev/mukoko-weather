/**
 * Moon phase and moonrise — pure, deterministic, no network.
 *
 * Phase uses the mean synodic month from a reference new moon (2000-01-06
 * 18:14 UTC). That is accurate to roughly half a day, which is far finer than
 * the eight named phases need. Moonrise is a port of the moon-position and
 * rise/set search from SunCalc (MIT, Vladimir Agafonkin), reimplemented here
 * so the app takes no new dependency.
 */

/** Length of the mean synodic month in days. */
export const SYNODIC_MONTH_DAYS = 29.530588853;

/** Reference new moon: 2000-01-06 18:14 UTC (Unix ms). */
const EPOCH_NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14);

const DAY_MS = 86_400_000;

export const MOON_PHASE_NAMES = [
  "New moon",
  "Waxing crescent",
  "First quarter",
  "Waxing gibbous",
  "Full moon",
  "Waning gibbous",
  "Last quarter",
  "Waning crescent",
] as const;

export type MoonPhaseName = (typeof MOON_PHASE_NAMES)[number];

export interface MoonPhase {
  /** 0 = new moon, 0.5 = full moon, wraps back to 0. */
  phase: number;
  /** Fraction of the lunar disc that is lit, 0–1. */
  illumination: number;
  name: MoonPhaseName;
}

/** Moon phase, illumination and name for an instant. */
export function moonPhase(date: Date): MoonPhase {
  const t = date.getTime();
  const days = Number.isFinite(t) ? (t - EPOCH_NEW_MOON_MS) / DAY_MS : 0;
  let phase = (days / SYNODIC_MONTH_DAYS) % 1;
  if (phase < 0) phase += 1;
  // Guard against floating-point landing exactly on 1.
  if (phase >= 1) phase = 0;

  const illumination = (1 - Math.cos(2 * Math.PI * phase)) / 2;
  // Eight equal bins centred on each named phase.
  const index = Math.round(phase * 8) % 8;
  return { phase, illumination, name: MOON_PHASE_NAMES[index] };
}

// ---------------------------------------------------------------------------
// Moonrise (SunCalc port)
// ---------------------------------------------------------------------------

const rad = Math.PI / 180;
const obliquity = rad * 23.4397; // obliquity of the Earth
const J1970 = 2440588;
const J2000 = 2451545;

function toJulian(date: Date): number {
  return date.valueOf() / DAY_MS - 0.5 + J1970;
}

function toDays(date: Date): number {
  return toJulian(date) - J2000;
}

function rightAscension(l: number, b: number): number {
  return Math.atan2(
    Math.sin(l) * Math.cos(obliquity) - Math.tan(b) * Math.sin(obliquity),
    Math.cos(l),
  );
}

function declination(l: number, b: number): number {
  return Math.asin(
    Math.sin(b) * Math.cos(obliquity) +
      Math.cos(b) * Math.sin(obliquity) * Math.sin(l),
  );
}

function siderealTime(d: number, lw: number): number {
  return rad * (280.16 + 360.9856235 * d) - lw;
}

function astroRefraction(h: number): number {
  if (h < 0) return 0;
  return 0.0002967 / Math.tan(h + 0.00312536 / (h + 0.08901179));
}

function moonCoords(d: number): { ra: number; dec: number } {
  const L = rad * (218.316 + 13.176396 * d); // ecliptic longitude
  const M = rad * (134.963 + 13.064993 * d); // mean anomaly
  const F = rad * (93.272 + 13.22935 * d); // mean distance
  const l = L + rad * 6.289 * Math.sin(M);
  const b = rad * 5.128 * Math.sin(F);
  return { ra: rightAscension(l, b), dec: declination(l, b) };
}

/** Apparent altitude of the moon in radians, refraction included. */
function moonAltitude(date: Date, lat: number, lon: number): number {
  const lw = rad * -lon;
  const phi = rad * lat;
  const d = toDays(date);
  const c = moonCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  const h = Math.asin(
    Math.sin(phi) * Math.sin(c.dec) +
      Math.cos(phi) * Math.cos(c.dec) * Math.cos(H),
  );
  return h + astroRefraction(h);
}

/**
 * Find the moonrise on the local calendar day that starts at `dayStart`
 * (local midnight), by scanning 24 h in 2-hour steps for altitude crossings.
 * Returns null when the moon does not rise that day.
 */
function riseOnDay(dayStart: Date, lat: number, lon: number): Date | null {
  // Standard refraction + moon's semi-diameter, as in SunCalc.
  const hc = 0.133 * rad;
  const hoursLater = (h: number) =>
    new Date(dayStart.getTime() + (h * DAY_MS) / 24);
  const alt = (h: number) => moonAltitude(hoursLater(h), lat, lon) - hc;

  let h0 = alt(0);
  for (let i = 1; i <= 24; i += 2) {
    const h1 = alt(i);
    const h2 = alt(i + 1);
    const a = (h0 + h2) / 2 - h1;
    const b = (h2 - h0) / 2;
    const xe = -b / (2 * a);
    const ye = (a * xe + b) * xe + h1;
    const dDisc = b * b - 4 * a * h1;
    let roots = 0;
    let x1 = 0;
    let x2 = 0;
    if (dDisc >= 0) {
      const dx = Math.sqrt(dDisc) / (Math.abs(a) * 2);
      x1 = xe - dx;
      x2 = xe + dx;
      if (Math.abs(x1) <= 1) roots++;
      if (Math.abs(x2) <= 1) roots++;
      if (x1 < -1) x1 = x2;
    }
    if (roots === 1) {
      // A single crossing in this window: rising if the altitude was negative.
      if (h0 < 0) return hoursLater(i + x1);
    } else if (roots === 2) {
      const rise = i + (ye < 0 ? x2 : x1);
      return hoursLater(rise);
    }
    h0 = h2;
  }
  return null;
}

/**
 * Next moonrise strictly after `date` at the given coordinates, or null when
 * the moon does not rise within the next ~2 days (possible at high latitudes).
 * Always returns a time within ~25 h of `date` when it returns a value.
 */
export function nextMoonrise(
  date: Date,
  lat: number,
  lon: number,
): Date | null {
  if (
    !Number.isFinite(date.getTime()) ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90
  ) {
    return null;
  }
  // Scan from the local midnight of the day before, so a rise shortly after
  // `date` that belongs to the previous calendar window is still caught.
  const start = new Date(date.getTime());
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 1);

  for (let day = 0; day < 4; day++) {
    const dayStart = new Date(start.getTime());
    dayStart.setDate(start.getDate() + day);
    const rise = riseOnDay(dayStart, lat, lon);
    if (rise && rise.getTime() > date.getTime()) return rise;
  }
  return null;
}
