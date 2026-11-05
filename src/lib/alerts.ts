/**
 * In-app alerts: what the notifications centre lists for a person's places
 * (mukoko-dev/mukoko-weather#289). Pure: no storage, no network, no clock
 * (`now` is passed in). Four kinds: frost, lightning, wildfire, flooding.
 *
 * Where each kind comes from, honestly:
 *
 * - **Frost, lightning, flooding (forecast)**: derived on the device from the
 *   forecast the app already holds for the place. They are ADVISORIES. They say
 *   so ("Frost advisory"), they say "from the forecast, not an official
 *   warning", they use "possible" and "likely" and never "will" or
 *   "guaranteed", and they carry the time the forecast is from, in the PLACE's
 *   time zone.
 * - **Flooding and wildfire (community)**: what people reported near the place
 *   in the last 24 hours (`weather.weather_reports`, through the report list
 *   the page already fetched). Shown as "Community report, unverified". A
 *   wildfire alert exists ONLY when there is a report; there is deliberately
 *   NO model-derived wildfire alert in this version (no fire-weather index, no
 *   satellite hotspots), so the app never claims a fire it has not been told
 *   about.
 *
 * No emergency numbers are written anywhere: the copy says "call your local
 * emergency services" because the number differs by country.
 *
 * Every forecast rule reads the next {@link ALERT_THRESHOLDS.windowHours}
 * hours from the place's current hour, in the place's own time zone
 * (`location-time.ts`), never the viewer's clock.
 */

import {
  type HourlyWeather,
  type WeatherData,
  checkFrostRisk,
  isFrostHour,
  wmoToInsightHazards,
} from "./weather";
import {
  currentWallHourMs,
  locationHourOf,
  nowWallClockMs,
  wallClockLabel,
  wallClockMs,
  wallDateString,
  weatherOffsetSeconds,
} from "./location-time";
import { RAIN_SCALE } from "./weather-scales";

// ---------------------------------------------------------------------------
// Kinds and shapes
// ---------------------------------------------------------------------------

export const ALERT_KINDS = [
  "frost",
  "lightning",
  "wildfire",
  "flooding",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** The label a person sees for a kind (also the settings toggle labels). */
export const ALERT_KIND_LABELS: Readonly<Record<AlertKind, string>> = {
  frost: "Frost",
  lightning: "Lightning",
  wildfire: "Wildfire",
  flooding: "Flooding",
};

/**
 * `advisory`: derived from the forecast by this app, not an official warning.
 * `community`: what people reported, unverified.
 */
export type AlertLevel = "advisory" | "community";

export type AlertSeverity = "moderate" | "high" | "severe";

const SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = {
  moderate: 1,
  high: 2,
  severe: 3,
};

export interface Alert {
  /** `{place}:{kind}:{level}`, unique in one result. */
  id: string;
  kind: AlertKind;
  level: AlertLevel;
  severity: AlertSeverity;
  placeSlug: string;
  placeName: string;
  /** "Frost advisory", "Community report: flooding". */
  headline: string;
  /** One plain-language sentence (two for a community report: it says what to do). */
  message: string;
  /** When it applies, in the place's time ("Tonight, between 22:00 and 06:00"). */
  when: string;
  /** What the data is as of ("Forecast as of 14:05 (Harare time)", "Latest report 25 min ago"). */
  asOf: string;
  /** Epoch ms of the forecast or of the latest report (for ordering and tests). */
  asOfMs: number;
  /** "From the forecast, not an official warning" or "Community report, unverified". */
  source: string;
  /** Community alerts only: how many reports. */
  reportCount?: number;
}

/** The community report fields the alerts read (the list the page fetched). */
export interface CommunityReportLike {
  reportType: string;
  severity?: string;
  reportedAt: string;
  verified?: boolean;
}

/** One place and the data held for it. `null` means nothing usable is held. */
export interface AlertPlace {
  slug: string;
  name: string;
  weather: WeatherData | null;
  /** When the forecast came off the network (epoch ms). */
  fetchedAt: number | null;
  /** Community reports for the last 24 hours, or null while not loaded. */
  reports: readonly CommunityReportLike[] | null;
}

export interface AlertsResult {
  /** Most serious first. */
  alerts: Alert[];
  /** Places whose forecast was recent enough to check. */
  placesChecked: number;
  placesTotal: number;
  /** Newest forecast time among the places checked (epoch ms), or null. */
  forecastUpdatedAt: number | null;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;

/** The Rain scale's "from" for a named band (the radar legend's own breakpoints). */
function rainFrom(name: string, fallback: number): number {
  return RAIN_SCALE.bands.find((b) => b.name === name)?.from ?? fallback;
}

/**
 * The numbers every rule uses, in one place.
 *
 * **These are OUR engineering defaults. They are untuned: tune with data**,
 * like the forecast blend weights. They are not copied from any national
 * weather service, they were not fitted to observed events, and the right
 * values differ by climate (25 mm in a day is routine in a tropical wet
 * season, remarkable in a desert). The rules lean towards NOT crying wolf: an
 * advisory that fires every week teaches people to ignore the one that
 * matters. A forecast model smooths rain over its grid cell, so a point
 * maximum is usually larger than the model shows; that argues against raising
 * the rain numbers further.
 *
 * Frost has no number here: it is the app's existing frost rule
 * (`isFrostHour` / `checkFrostRisk` in `weather.ts`: 3°C or below between 22:00
 * and 08:00 at the place), so the banner on the page and the advisory in this
 * list cannot disagree.
 */
export const ALERT_THRESHOLDS = {
  /** Hours ahead of the place's current hour that every forecast rule reads. */
  windowHours: 24,
  /**
   * A stored forecast older than this is not used (6 hours). The page shows
   * a stored copy for longer, with its age; an advisory from a forecast this
   * old would be guessing.
   */
  maxForecastAgeMs: 6 * HOUR_MS,
  /**
   * The thunderstorm insight (`WeatherInsights.thunderstormProbability`) is a
   * "now to the next 6 hours" proxy fixed at fetch time, so it is trusted only
   * for this long after the fetch (1 hour).
   */
  insightMaxAgeMs: HOUR_MS,
  lightning: {
    /** Insight probability, percent. */
    probabilityPct: { moderate: 40, high: 70 },
    /** Hours in the window with a thunderstorm weather code (WMO 95, 96, 99). */
    thunderHours: { moderate: 1, high: 3 },
    /** A thunderstorm code with hail (WMO 96 and above) is high on its own. */
    hailFromCode: 96,
  },
  flooding: {
    /** Rain expected over the window, millimetres. */
    totalMm: { moderate: 40, high: 70 },
    /**
     * Heaviest single hour, mm/h: the Rain scale's "Very heavy" and "Intense"
     * bands (`RAIN_SCALE`, the radar legend), so the map and this list use one
     * set of breakpoints.
     */
    peakMmPerHour: {
      moderate: rainFrom("Very heavy", 24),
      high: rainFrom("Intense", 47),
    },
  },
  community: {
    /** How far back a report still counts, hours (the report list's window). */
    windowHours: 24,
  },
} as const;

/** The wording that makes an advisory an advisory. */
export const ADVISORY_SOURCE = "From the forecast, not an official warning";
export const COMMUNITY_SOURCE = "Community report, unverified";
export const COMMUNITY_SOURCE_MATCHED =
  "Community report, matches the forecast";

// ---------------------------------------------------------------------------
// Small helpers (place time)
// ---------------------------------------------------------------------------

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** "Harare" -> a label for "Harare time". */
function placeTimeName(name: string): string {
  return name.trim() || "the place";
}

/** "HH:00" for a wall ms-if-UTC value. */
function hourLabel(wallMs: number): string {
  return wallClockLabel(Math.floor(wallMs / HOUR_MS) * HOUR_MS);
}

/** 0 for the place's today, 1 for tomorrow (a 24-hour window reaches no further). */
function dayDelta(wallMs: number, todayWallMs: number): number {
  const a = Date.parse(`${wallDateString(wallMs)}T00:00:00Z`);
  const b = Date.parse(`${wallDateString(todayWallMs)}T00:00:00Z`);
  return Math.round((a - b) / (24 * HOUR_MS));
}

function dayWord(delta: number): string {
  return delta <= 0 ? "today" : delta === 1 ? "tomorrow" : "later";
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "tonight", "tomorrow night", "early this morning", "early tomorrow morning". */
function nightWord(delta: number, hour: number): string {
  if (hour >= 18) return delta <= 0 ? "tonight" : "tomorrow night";
  return delta <= 0 ? "early this morning" : "early tomorrow morning";
}

/** "just now", "25 min ago", "3 h ago", "2 days ago": zone-free, so it is never an hour off. */
export function agoLabel(thenMs: number, nowMs: number): string {
  const mins = Math.floor((nowMs - thenMs) / 60_000);
  if (!Number.isFinite(mins) || mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** "Forecast as of 14:05 (Harare time)": the fetch time, read in the place's zone. */
export function forecastAsOf(
  fetchedAt: number,
  offsetSeconds: number,
  placeName: string,
): string {
  const clock = wallClockLabel(fetchedAt + offsetSeconds * 1000);
  return `Forecast as of ${clock} (${placeTimeName(placeName)} time)`;
}

/**
 * The window every forecast rule reads: indices [from, to) into the hourly
 * series, starting at the place's current hour. Null when the series does not
 * reach the current hour (a stale copy), so no rule runs on the past.
 */
export function forecastWindow(
  times: readonly string[] | undefined,
  offsetSeconds: number,
  now: Date,
): { from: number; to: number } | null {
  if (!times?.length) return null;
  const hourStart = currentWallHourMs(offsetSeconds, now);
  const from = times.findIndex((t) => {
    const k = wallClockMs(t, offsetSeconds);
    return k !== null && k >= hourStart;
  });
  if (from < 0) return null;
  return {
    from,
    to: Math.min(times.length, from + ALERT_THRESHOLDS.windowHours),
  };
}

// ---------------------------------------------------------------------------
// Forecast rules
// ---------------------------------------------------------------------------

interface ForecastContext {
  place: AlertPlace;
  weather: WeatherData;
  fetchedAt: number;
  offset: number;
  window: { from: number; to: number };
  now: Date;
  todayWallMs: number;
}

function baseAlert(
  ctx: ForecastContext,
  kind: AlertKind,
  severity: AlertSeverity,
  fields: Pick<Alert, "headline" | "message" | "when">,
): Alert {
  return {
    id: `${ctx.place.slug}:${kind}:advisory`,
    kind,
    level: "advisory",
    severity,
    placeSlug: ctx.place.slug,
    placeName: ctx.place.name,
    ...fields,
    asOf: forecastAsOf(ctx.fetchedAt, ctx.offset, ctx.place.name),
    asOfMs: ctx.fetchedAt,
    source: ADVISORY_SOURCE,
  };
}

/** Frost: the page's own frost rule, over the next window, for the first night. */
function frostAdvisory(ctx: ForecastContext): Alert | null {
  const { hourly } = ctx.weather;
  const { from, to } = ctx.window;
  const isFrostAt = (i: number): boolean => {
    const temp = hourly.temperature_2m?.[i];
    const hour = locationHourOf(hourly.time[i], ctx.offset);
    return finite(temp) && hour !== null && isFrostHour(hour, temp);
  };
  let start = -1;
  for (let i = from; i < to; i++) {
    if (isFrostAt(i)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  // The night is reported whole: it may run past the end of the 24 hour
  // window that decided it is near (the window picks the night, not its end).
  let end = start;
  while (end + 1 < hourly.time.length && isFrostAt(end + 1)) end++;

  // checkFrostRisk is the one place that turns temperatures into a frost
  // level; hand it just this night's hours.
  const night = {
    time: hourly.time.slice(start, end + 1),
    temperature_2m: hourly.temperature_2m.slice(start, end + 1),
  } as unknown as HourlyWeather;
  const risk = checkFrostRisk(night, ctx.offset);
  if (!risk) return null;

  const startWall = wallClockMs(hourly.time[start], ctx.offset);
  const endWall = wallClockMs(hourly.time[end], ctx.offset);
  if (startWall === null || endWall === null) return null;
  const startHour = locationHourOf(hourly.time[start], ctx.offset) ?? 22;
  const word = nightWord(dayDelta(startWall, ctx.todayWallMs), startHour);
  const lowest = Math.round(risk.lowestTemp);
  const likely = risk.risk !== "moderate";

  return baseAlert(ctx, "frost", risk.risk, {
    headline: "Frost advisory",
    message: `Frost is ${likely ? "likely" : "possible"}, with a low near ${lowest}°C. Cover seedlings and sensitive plants.`,
    when: `${capital(word)}, between ${hourLabel(startWall)} and ${hourLabel(endWall)}`,
  });
}

/** Lightning: thunderstorm weather codes in the window, and the thunderstorm insight while fresh. */
function lightningAdvisory(ctx: ForecastContext): Alert | null {
  const t = ALERT_THRESHOLDS.lightning;
  const { hourly } = ctx.weather;
  const { from, to } = ctx.window;

  let thunderHours = 0;
  let hail = false;
  let first = -1;
  let last = -1;
  for (let i = from; i < to; i++) {
    const code = hourly.weather_code?.[i];
    if (!finite(code)) continue;
    // WMO 95, 96, 99 (thunderstorm, with or without hail): the probability the
    // rest of the app already assigns to a code is non-zero only for these.
    if (wmoToInsightHazards(code).thunderstormProbability <= 0) continue;
    thunderHours++;
    if (code >= t.hailFromCode) hail = true;
    if (first < 0) first = i;
    last = i;
  }

  const insightAgeMs = ctx.now.getTime() - ctx.fetchedAt;
  const probability =
    insightAgeMs <= ALERT_THRESHOLDS.insightMaxAgeMs
      ? ctx.weather.insights?.thunderstormProbability
      : undefined;

  let severity: AlertSeverity | null = null;
  const raise = (s: AlertSeverity) => {
    if (!severity || SEVERITY_RANK[s] > SEVERITY_RANK[severity]) severity = s;
  };
  if (thunderHours >= t.thunderHours.moderate) raise("moderate");
  if (thunderHours >= t.thunderHours.high || hail) raise("high");
  if (finite(probability)) {
    if (probability >= t.probabilityPct.moderate) raise("moderate");
    if (probability >= t.probabilityPct.high) raise("high");
  }
  if (!severity) return null;

  const likely = severity !== "moderate";
  const message = hail
    ? `Thunderstorms with hail are ${likely ? "likely" : "possible"}. If you hear thunder, go indoors.`
    : `Thunderstorms are ${likely ? "likely" : "possible"}. If you hear thunder, go indoors.`;

  let when = "In the next few hours";
  if (first >= 0) {
    const a = wallClockMs(hourly.time[first], ctx.offset);
    const b = wallClockMs(hourly.time[last], ctx.offset);
    if (a !== null && b !== null) {
      const day = capital(dayWord(dayDelta(a, ctx.todayWallMs)));
      when =
        first === last
          ? `${day} around ${hourLabel(a)}`
          : `${day} between ${hourLabel(a)} and ${hourLabel(b)}`;
    }
  }
  return baseAlert(ctx, "lightning", severity, {
    headline: "Lightning advisory",
    message,
    when,
  });
}

/**
 * Flooding from the forecast: rain only (no river level, soil or terrain), so
 * the sentence says "heavy rain", not "a flood". The total over the window and
 * the heaviest single hour are each checked against the table.
 */
function floodingAdvisory(ctx: ForecastContext): Alert | null {
  const t = ALERT_THRESHOLDS.flooding;
  const { hourly } = ctx.weather;
  const { from, to } = ctx.window;

  let total = 0;
  let peak = 0;
  let peakAt = -1;
  for (let i = from; i < to; i++) {
    const mm = hourly.precipitation?.[i];
    if (!finite(mm) || mm <= 0) continue;
    total += mm;
    if (mm > peak) {
      peak = mm;
      peakAt = i;
    }
  }

  let severity: AlertSeverity | null = null;
  if (total >= t.totalMm.moderate || peak >= t.peakMmPerHour.moderate) {
    severity = "moderate";
  }
  if (total >= t.totalMm.high || peak >= t.peakMmPerHour.high) {
    severity = "high";
  }
  if (!severity) return null;

  const likely = severity === "high";
  const totalText = Math.round(total);
  const peakText = Math.round(peak);
  let when = "In the next 24 hours";
  if (peakAt >= 0) {
    const wall = wallClockMs(hourly.time[peakAt], ctx.offset);
    if (wall !== null) {
      when = `Next 24 hours, heaviest ${dayWord(dayDelta(wall, ctx.todayWallMs))} around ${hourLabel(wall)}`;
    }
  }
  return baseAlert(ctx, "flooding", severity, {
    headline: "Flood advisory",
    message: `Heavy rain is ${likely ? "likely" : "possible"}: about ${totalText} mm in total, up to ${peakText} mm in one hour. Low-lying ground and roads can flood.`,
    when,
  });
}

// ---------------------------------------------------------------------------
// Community reports
// ---------------------------------------------------------------------------

/** What each community kind says and tells a person to do. */
const COMMUNITY_COPY: Partial<
  Record<
    AlertKind,
    { reportType: string; noun: string; advice: string; headline: string }
  >
> = {
  flooding: {
    reportType: "flooding",
    noun: "flooding",
    advice: "Do not walk or drive through floodwater.",
    headline: "Community report: flooding",
  },
  wildfire: {
    reportType: "wildfire",
    noun: "a wildfire",
    advice:
      "If you see flames or smoke close by, move away and call your local emergency services.",
    headline: "Community report: wildfire",
  },
};

/**
 * The severity people gave their report, as ours. An unverified report is
 * never ranked above "high": one person's word must not outrank a forecast
 * advisory the app worked out itself. A report the forecast bears out
 * (`matched`) keeps "severe".
 */
function communitySeverity(
  s: string | undefined,
  matched: boolean,
): AlertSeverity {
  if (s === "severe") return matched ? "severe" : "high";
  return s === "moderate" ? "high" : "moderate";
}

function peopleReported(n: number): string {
  return n === 1 ? "1 person reported" : `${n} people reported`;
}

/**
 * Community alerts for one place: reports of `flooding` and `wildfire` from
 * the last 24 hours, one alert per kind however many reports. Needs no
 * forecast.
 */
export function communityAlerts(
  place: Pick<AlertPlace, "slug" | "name" | "reports">,
  nowMs: number,
): Alert[] {
  if (!place.reports?.length) return [];
  const windowMs = ALERT_THRESHOLDS.community.windowHours * HOUR_MS;
  const out: Alert[] = [];
  for (const kind of ["wildfire", "flooding"] as const) {
    const copy = COMMUNITY_COPY[kind];
    if (!copy) continue;
    let count = 0;
    let latest = 0;
    let worst: string | undefined;
    let matched = false;
    for (const r of place.reports) {
      if (r.reportType !== copy.reportType) continue;
      const at = Date.parse(r.reportedAt);
      // Unreadable, future-dated (clock skew beyond a minute) or older than
      // the window: not counted.
      if (!Number.isFinite(at) || at > nowMs + 60_000) continue;
      if (nowMs - at > windowMs) continue;
      count++;
      latest = Math.max(latest, at);
      if (
        SEVERITY_RANK[communitySeverity(r.severity, true)] >
        SEVERITY_RANK[communitySeverity(worst, true)]
      ) {
        worst = r.severity;
      }
      if (r.verified === true) matched = true;
    }
    if (count === 0) continue;
    const severity = communitySeverity(worst, matched);
    out.push({
      id: `${place.slug}:${kind}:community`,
      kind,
      level: "community",
      severity,
      placeSlug: place.slug,
      placeName: place.name,
      headline: copy.headline,
      message: `${peopleReported(count)} ${copy.noun} near ${place.name}. ${copy.advice}`,
      when: "In the last 24 hours",
      asOf: `Latest report ${agoLabel(latest, nowMs)}`,
      asOfMs: latest,
      source: matched ? COMMUNITY_SOURCE_MATCHED : COMMUNITY_SOURCE,
      reportCount: count,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// One place, many places
// ---------------------------------------------------------------------------

/** True when the place's stored forecast is recent enough and reaches now. */
export function forecastUsable(
  place: AlertPlace,
  now: Date,
): place is AlertPlace & { weather: WeatherData; fetchedAt: number } {
  if (!place.weather || !finite(place.fetchedAt)) return false;
  if (now.getTime() - place.fetchedAt > ALERT_THRESHOLDS.maxForecastAgeMs) {
    return false;
  }
  return (
    forecastWindow(
      place.weather.hourly?.time,
      weatherOffsetSeconds(place.weather, now),
      now,
    ) !== null
  );
}

/** Every alert for one place, unordered. */
export function placeAlerts(place: AlertPlace, now: Date): Alert[] {
  const out: Alert[] = [];
  if (forecastUsable(place, now)) {
    const offset = weatherOffsetSeconds(place.weather, now);
    const window = forecastWindow(place.weather.hourly.time, offset, now);
    if (window) {
      const ctx: ForecastContext = {
        place,
        weather: place.weather,
        fetchedAt: place.fetchedAt,
        offset,
        window,
        now,
        todayWallMs: nowWallClockMs(offset, now),
      };
      for (const rule of [frostAdvisory, lightningAdvisory, floodingAdvisory]) {
        const alert = rule(ctx);
        if (alert) out.push(alert);
      }
    }
  }
  out.push(...communityAlerts(place, now.getTime()));
  return out;
}

const KIND_ORDER: Readonly<Record<AlertKind, number>> = {
  frost: 0,
  lightning: 1,
  flooding: 2,
  wildfire: 3,
};

/**
 * Most serious first; then forecast advisories before community reports; then
 * the order the places were given (the place on screen first), then kind.
 */
export function sortAlerts(
  alerts: readonly Alert[],
  placeOrder: readonly string[],
): Alert[] {
  const rank = (slug: string) => {
    const i = placeOrder.indexOf(slug);
    return i < 0 ? placeOrder.length : i;
  };
  return [...alerts].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (a.level === b.level ? 0 : a.level === "advisory" ? -1 : 1) ||
      rank(a.placeSlug) - rank(b.placeSlug) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
  );
}

/** The alerts for all of a person's places, with how much was checked. */
export function collectAlerts(
  places: readonly AlertPlace[],
  now: Date,
): AlertsResult {
  const alerts: Alert[] = [];
  let checked = 0;
  let updated: number | null = null;
  for (const place of places) {
    if (forecastUsable(place, now)) {
      checked++;
      updated = Math.max(updated ?? 0, place.fetchedAt);
    }
    alerts.push(...placeAlerts(place, now));
  }
  return {
    alerts: sortAlerts(
      alerts,
      places.map((p) => p.slug),
    ),
    placesChecked: checked,
    placesTotal: places.length,
    forecastUpdatedAt: updated,
  };
}

// ---------------------------------------------------------------------------
// Copy the settings and the empty state share
// ---------------------------------------------------------------------------

/** What each switch in the notification settings means, in plain words. */
export const ALERT_KIND_ABOUT: Readonly<Record<AlertKind, string>> = {
  frost: "A night at or below 3°C in the forecast for your places.",
  lightning: "Thunderstorms in the forecast for your places.",
  wildfire:
    "People reporting a wildfire near your places. Community reports only: there is no forecast or satellite wildfire alert yet.",
  flooding:
    "Heavy rain in the forecast, or people reporting flooding, near your places.",
};

/** The one line under the list's heading: what these alerts are and are not. */
export const ALERTS_INTRO =
  "Advisories for your places, worked out on this device from their forecasts, and what people have reported. They are not official warnings. Delivery is best effort.";

export interface EmptyAlertsCopy {
  title: string;
  detail: string;
}

function placesText(n: number): string {
  return n === 1 ? "1 place" : `${n} places`;
}

/**
 * What the list says when it has no alert to show. It never says "no alerts"
 * when nothing was checked, and it says when the forecasts it used were last
 * updated (on the person's own clock: `viewerOffsetSeconds`).
 *
 * `hidden` is how many alerts exist but belong to a kind the person switched
 * off.
 */
export function emptyAlertsCopy(
  result: Pick<AlertsResult, "placesChecked" | "forecastUpdatedAt">,
  hidden: number,
  viewerOffsetSeconds: number,
): EmptyAlertsCopy {
  const hiddenText =
    hidden > 0
      ? ` ${hidden === 1 ? "1 alert is" : `${hidden} alerts are`} hidden because you switched that kind off.`
      : "";
  if (result.placesChecked === 0 || result.forecastUpdatedAt === null) {
    return {
      title: "Nothing to check yet",
      detail: `No recent forecast is stored on this device for your places. Open a place and its forecast will be checked here.${hiddenText}`,
    };
  }
  const clock = wallClockLabel(
    result.forecastUpdatedAt + viewerOffsetSeconds * 1000,
  );
  return {
    title: "No alerts for your places right now",
    detail: `Checked ${placesText(result.placesChecked)}, with forecasts last updated at ${clock}.${hiddenText}`,
  };
}
