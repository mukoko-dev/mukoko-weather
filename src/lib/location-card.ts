/**
 * Pure helpers for the iOS-style Locations list (`/locations`).
 *
 * Nothing here touches the DOM, the store or the network: the page passes in
 * weather payloads and coordinates, and gets back display strings, the
 * condition-sky class and the accessible name for each card.
 */

import { weatherCodeToInfo } from "@/lib/weather";

/** Fauna class (globals.css `.oryx-*`) that paints a card's condition sky. */
export type OryxSky =
  | "oryx-clear-day"
  | "oryx-clear-night"
  | "oryx-cloudy"
  | "oryx-rain"
  | "oryx-storm"
  | "oryx-fog"
  | "oryx-snow";

/**
 * WMO weather code + day/night → sky class.
 *
 * Partly cloudy (2) keeps the clear sky, as the location page's backdrop does.
 * Returns literal class names only, so Tailwind/JIT keeps every one.
 */
export function cardTheme(weatherCode: number, isDay: boolean): OryxSky {
  if (weatherCode === 0 || weatherCode === 1 || weatherCode === 2) {
    return isDay ? "oryx-clear-day" : "oryx-clear-night";
  }
  if (weatherCode === 3) return "oryx-cloudy";
  if (weatherCode === 45 || weatherCode === 48) return "oryx-fog";
  if (weatherCode >= 95 && weatherCode <= 99) return "oryx-storm";
  if (
    (weatherCode >= 71 && weatherCode <= 77) ||
    weatherCode === 85 ||
    weatherCode === 86
  ) {
    return "oryx-snow";
  }
  if (
    (weatherCode >= 51 && weatherCode <= 67) ||
    (weatherCode >= 80 && weatherCode <= 82)
  ) {
    return "oryx-rain";
  }
  return "oryx-cloudy";
}

/**
 * Title-cased condition text for a card ("Partly Cloudy", "Overcast").
 * Built on weatherCodeToInfo so the wording stays in one place.
 */
export function cardConditionLabel(weatherCode: number): string {
  return weatherCodeToInfo(weatherCode)
    .label.split(" ")
    .map((word) =>
      word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word,
    )
    .join(" ");
}

/**
 * Fixed UTC offsets (seconds) for countries that do not observe DST, keyed by
 * ISO 3166-1 alpha-2. The weather payload does not carry the zone offset, so
 * these take precedence over the longitude estimate, which is wrong for
 * countries whose civil time sits far from their solar meridian (China,
 * Thailand, Myanmar…). Covers the African, South-East Asian and Gulf countries
 * this product is built around. Add a country only if it is fixed-offset.
 */
export const FIXED_UTC_OFFSET_SECONDS: Readonly<Record<string, number>> = {
  // Africa
  ZW: 7200,
  ZA: 7200,
  ZM: 7200,
  MW: 7200,
  MZ: 7200,
  BW: 7200,
  NA: 7200,
  RW: 7200,
  BI: 7200,
  LS: 7200,
  SZ: 7200,
  SD: 7200,
  LY: 7200,
  KE: 10800,
  TZ: 10800,
  UG: 10800,
  ET: 10800,
  SO: 10800,
  DJ: 10800,
  ER: 10800,
  MG: 10800,
  MU: 14400,
  NG: 3600,
  CM: 3600,
  AO: 3600,
  CG: 3600,
  GA: 3600,
  BJ: 3600,
  NE: 3600,
  TD: 3600,
  DZ: 3600,
  TN: 3600,
  GH: 0,
  SN: 0,
  CI: 0,
  ML: 0,
  TG: 0,
  BF: 0,
  GN: 0,
  LR: 0,
  SL: 0,
  GM: 0,
  MR: 0,
  CV: -3600,
  // South and East Asia, Gulf
  SG: 28800,
  MY: 28800,
  PH: 28800,
  BN: 28800,
  HK: 28800,
  CN: 28800,
  TW: 28800,
  TH: 25200,
  VN: 25200,
  KH: 25200,
  LA: 25200,
  MM: 23400,
  IN: 19800,
  LK: 19800,
  NP: 20700,
  BD: 21600,
  PK: 18000,
  AE: 14400,
  OM: 14400,
  SA: 10800,
  QA: 10800,
  KW: 10800,
  BH: 10800,
  JP: 32400,
  KR: 32400,
};

/**
 * Best available UTC offset (seconds) for a place.
 *
 * Order: an explicit `utc_offset_seconds` on the weather payload (if the
 * backend ever supplies one) → the fixed-offset country table → the longitude
 * estimate (15° per hour, rounded to the quarter hour).
 */
export function resolveUtcOffsetSeconds(
  explicit: number | null | undefined,
  lon: number,
  countryCode?: string | null,
): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.round(explicit);
  }
  const code = (countryCode ?? "").toUpperCase();
  if (
    code &&
    Object.prototype.hasOwnProperty.call(FIXED_UTC_OFFSET_SECONDS, code)
  ) {
    return FIXED_UTC_OFFSET_SECONDS[code];
  }
  if (!Number.isFinite(lon)) return 0;
  const quarterHours = Math.round((lon / 15) * 4);
  return quarterHours * 900;
}

/**
 * "HH:MM" wall-clock time at a place, given an instant and that place's UTC
 * offset. Pure arithmetic on UTC getters, so it is deterministic in tests and
 * does not depend on the viewer's own time zone.
 */
export function localTimeLabel(
  instant: Date | number | string,
  offsetSeconds: number,
): string {
  const ms = new Date(instant).getTime();
  if (!Number.isFinite(ms)) return "";
  const shifted = new Date(ms + offsetSeconds * 1000);
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Whole-degree label for a temperature: 25.4 → "25°", -0.6 → "-1°". */
export function tempLabel(value: number): string {
  return `${Math.round(value)}°`;
}

/** iOS-style high/low line: "H:27° L:17°". */
export function highLowLabel(high: number, low: number): string {
  return `H:${Math.round(high)}° L:${Math.round(low)}°`;
}

/** What one card shows once its weather has loaded. */
export interface CardSummary {
  temperature: number;
  weatherCode: number;
  isDay: boolean;
  high: number;
  low: number;
  condition: string;
  sky: OryxSky;
  utcOffsetSeconds: number;
}

/**
 * Minimal shape of `/api/py/weather` the card needs. Kept structural so the
 * helper accepts any WeatherData-compatible payload without importing it.
 */
export interface CardWeatherInput {
  current: {
    temperature_2m: number;
    weather_code: number;
    is_day?: number;
  };
  daily: {
    temperature_2m_max: number[];
    temperature_2m_min: number[];
  };
  utc_offset_seconds?: number;
}

/** Build a card's display model from a weather payload. Null when the payload
 *  is missing the fields a card needs. */
export function summarizeCardWeather(
  weather: CardWeatherInput | null | undefined,
  lon: number,
  countryCode?: string | null,
): CardSummary | null {
  const current = weather?.current;
  const high = weather?.daily?.temperature_2m_max?.[0];
  const low = weather?.daily?.temperature_2m_min?.[0];
  if (
    !current ||
    typeof current.temperature_2m !== "number" ||
    typeof current.weather_code !== "number" ||
    typeof high !== "number" ||
    typeof low !== "number"
  ) {
    return null;
  }
  const isDay = current.is_day !== 0;
  return {
    temperature: current.temperature_2m,
    weatherCode: current.weather_code,
    isDay,
    high,
    low,
    condition: cardConditionLabel(current.weather_code),
    sky: cardTheme(current.weather_code, isDay),
    utcOffsetSeconds: resolveUtcOffsetSeconds(
      weather?.utc_offset_seconds,
      lon,
      countryCode,
    ),
  };
}

/**
 * The card's accessible name, e.g.
 * "Harare, 25°, Mostly Cloudy, high 27 low 17". Badges (current location,
 * home) are appended so the list reads the same as the visual cues.
 */
export function cardAccessibleName(options: {
  name: string;
  summary: CardSummary | null;
  isCurrent?: boolean;
  isHome?: boolean;
}): string {
  const parts: string[] = [options.name];
  if (options.summary) {
    const s = options.summary;
    parts.push(
      tempLabel(s.temperature),
      s.condition,
      `high ${Math.round(s.high)} low ${Math.round(s.low)}`,
    );
  } else {
    parts.push("Weather unavailable");
  }
  if (options.isCurrent) parts.push("My location");
  if (options.isHome) parts.push("Home");
  return parts.join(", ");
}

/**
 * The ordered list of places the Locations page shows: the current location
 * first (when there is one), then saved places in their saved order. A saved
 * place equal to the current location is not repeated, and the list is capped
 * so a malformed store can never render more cards than the saved-place limit
 * allows.
 */
export interface LocationListEntry {
  slug: string;
  isCurrent: boolean;
}

export function buildLocationList(
  currentSlug: string | null,
  savedSlugs: readonly string[],
  maxSaved: number,
): LocationListEntry[] {
  const entries: LocationListEntry[] = [];
  const seen = new Set<string>();
  if (currentSlug) {
    entries.push({ slug: currentSlug, isCurrent: true });
    seen.add(currentSlug);
  }
  for (const slug of savedSlugs.slice(0, Math.max(0, maxSaved))) {
    if (!slug || seen.has(slug)) continue;
    entries.push({ slug, isCurrent: false });
    seen.add(slug);
  }
  return entries;
}

/** Href for a card: `/` for the current location, `/{slug}` otherwise. */
export function cardHref(entry: LocationListEntry): string {
  return entry.isCurrent ? "/" : `/${entry.slug}`;
}

// ---------------------------------------------------------------------------
// Mineral plates — the tint behind each card (not condition-only colour)
// ---------------------------------------------------------------------------

/** Condition families a card plate can take. */
export type PlateCondition =
  | "clear"
  | "cloudy"
  | "rain"
  | "storm"
  | "fog"
  | "snow";

/** Mineral that tints a plate. Each one is an existing mineral token. */
export type PlateMineral =
  | "cobalt"
  | "sodalite"
  | "tanzanite"
  | "malachite"
  | "terracotta"
  | "gold";

/**
 * The plate name a card paints with, `plate-<condition>-<day|night>`. These
 * names follow the design brief's plate tokens. Until those tokens exist, the
 * mapping below resolves each name to a mineral token, which the card applies
 * through literal Tailwind classes (see `PLATE_CLASSES`).
 */
export function plateName(
  condition: PlateCondition,
  isDay: boolean,
): `plate-${PlateCondition}-${"day" | "night"}` {
  return `plate-${condition}-${isDay ? "day" : "night"}`;
}

/** Plate name → mineral. Hue follows the condition family, not the sky colour alone. */
export const PLATE_MINERAL: Readonly<Record<string, PlateMineral>> = {
  "plate-clear-day": "cobalt",
  "plate-clear-night": "sodalite",
  "plate-cloudy-day": "tanzanite",
  "plate-cloudy-night": "tanzanite",
  "plate-rain-day": "malachite",
  "plate-rain-night": "malachite",
  "plate-storm-day": "terracotta",
  "plate-storm-night": "terracotta",
  "plate-fog-day": "gold",
  "plate-fog-night": "gold",
  "plate-snow-day": "cobalt",
  "plate-snow-night": "cobalt",
};

/** Condition family of a sky class (the card's existing WMO mapping). */
export function plateConditionFor(sky: OryxSky): PlateCondition {
  switch (sky) {
    case "oryx-clear-day":
    case "oryx-clear-night":
      return "clear";
    case "oryx-rain":
      return "rain";
    case "oryx-storm":
      return "storm";
    case "oryx-fog":
      return "fog";
    case "oryx-snow":
      return "snow";
    default:
      return "cloudy";
  }
}

/**
 * Literal Tailwind classes for each mineral: a plate tint mixed into the card
 * surface, and the 4px leading edge. Kept as literals so Tailwind generates them.
 */
export const PLATE_CLASSES: Readonly<
  Record<PlateMineral, { plate: string; edge: string }>
> = {
  cobalt: {
    plate:
      "bg-[color-mix(in_oklab,var(--mineral-cobalt)_22%,var(--color-surface-card))]",
    edge: "border-l-[var(--mineral-cobalt)]",
  },
  sodalite: {
    plate:
      "bg-[color-mix(in_oklab,var(--mineral-sodalite)_24%,var(--color-surface-card))]",
    edge: "border-l-[var(--mineral-sodalite)]",
  },
  tanzanite: {
    plate:
      "bg-[color-mix(in_oklab,var(--mineral-tanzanite)_20%,var(--color-surface-card))]",
    edge: "border-l-[var(--mineral-tanzanite)]",
  },
  malachite: {
    plate:
      "bg-[color-mix(in_oklab,var(--mineral-malachite)_20%,var(--color-surface-card))]",
    edge: "border-l-[var(--mineral-malachite)]",
  },
  terracotta: {
    plate:
      "bg-[color-mix(in_oklab,var(--mineral-terracotta)_22%,var(--color-surface-card))]",
    edge: "border-l-[var(--mineral-terracotta)]",
  },
  gold: {
    plate:
      "bg-[color-mix(in_oklab,var(--mineral-gold)_20%,var(--color-surface-card))]",
    edge: "border-l-[var(--mineral-gold)]",
  },
};

/** Plate classes for a card summary (sky class + day/night). */
export function plateClassesFor(sky: OryxSky, isDay: boolean) {
  const name = plateName(plateConditionFor(sky), isDay);
  return PLATE_CLASSES[PLATE_MINERAL[name] ?? "tanzanite"];
}

// ---------------------------------------------------------------------------
// Batch loading and the per-slug weather cache
// ---------------------------------------------------------------------------

/** How long a card's weather is reused in memory before refetching. */
export const CARD_WEATHER_TTL_MS = 10 * 60 * 1000;

/** Parallel weather requests for the Locations list. */
export const CARD_FETCH_CONCURRENCY = 3;

/** Small TTL map. Entries expire lazily on read. */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Run `worker` over `items` with at most `limit` in flight. Results keep the
 * input order. The first worker error rejects the whole batch.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Math.max(1, Math.min(Math.floor(limit), items.length));
  const runLane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: lanes }, () => runLane()));
  return results;
}
