// Validation for everything the bridge accepts. These are the same rules as
// `weather_core::community` (workers/crates/weather-core/src/community.rs),
// which the Rust Worker applies first; the bridge applies them again because
// it is the last stop before the database and must not trust its caller.
// Nothing here builds a query from caller text: handlers pick fields.

export const THEMES = ["light", "dark", "system"] as const;

export const FORECAST_MODELS = [
  "best_match",
  "ecmwf_ifs",
  "ecmwf_ifs025",
  "ecmwf_aifs025_single",
  "gfs_seamless",
  "icon_global",
  "gem_global",
  "meteofrance_arpege_world",
  "meteofrance_seamless",
  "ecmwf_ifs04",
  "icon_seamless",
] as const;

export const REPORT_TYPES = [
  "light-rain",
  "heavy-rain",
  "thunderstorm",
  "hail",
  "flooding",
  "strong-wind",
  "clear-skies",
  "cloudy",
  "fog",
  "mist",
  "haze",
  "dust",
  "frost",
] as const;

export const SEVERITIES = ["mild", "moderate", "severe"] as const;

export const MAX_ACTIVITIES = 30;
export const MAX_SAVED_LOCATIONS = 10;
export const MAX_DESCRIPTION = 300;
export const MAX_LOCATION_NAME = 120;
/** The list never returns more than this many reports. */
export const LIST_LIMIT = 20;
/** At most this many storage keys in one list (a slug and its spot cell). */
export const MAX_LIST_KEYS = 4;

export interface Preferences {
  theme: string;
  selectedLocation: string;
  savedLocations: string[];
  selectedActivities: string[];
  hasOnboarded: boolean;
  selectedForecastModel: string;
}

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  theme: "system",
  selectedLocation: "",
  savedLocations: [],
  selectedActivities: [],
  hasOnboarded: false,
  selectedForecastModel: "best_match",
});

/** `Ok(value)` or `Err(detail)`; a detail is the text of a 400. */
export type Checked<T> = { ok: true; value: T } | { ok: false; detail: string };

const ok = <T>(value: T): Checked<T> => ({ ok: true, value });
const err = <T = never>(detail: string): Checked<T> => ({ ok: false, detail });

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const has = (o: Record<string, unknown>, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k) &&
  o[k] !== undefined &&
  o[k] !== null;

/** `^[a-z0-9-]{1,80}$`, the slug rule every endpoint applies. */
export function validSlug(s: string): boolean {
  return /^[a-z0-9-]{1,80}$/.test(s);
}

/** 1 to 64 of letters, digits, `-` and `_`. */
export function validDeviceId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/**
 * A key a report is stored under: a catalogue slug, or `geo:<geohash>` for a
 * coordinate spot (`weather_core::community::storage_slug`).
 */
export function validStorageKey(s: string): boolean {
  return validSlug(s) || /^geo:[0-9a-z]{5,7}$/.test(s);
}

/** The anonymous id a report and an upvote are keyed by: 16 hex characters. */
export function validVoter(s: string): boolean {
  return /^[0-9a-f]{16}$/.test(s);
}

export function validReportId(s: string): boolean {
  return /^[0-9a-f]{24}$/i.test(s);
}

function checkTheme(t: unknown): Checked<string> {
  return typeof t === "string" && (THEMES as readonly string[]).includes(t)
    ? ok(t)
    : err(`Invalid theme: ${show(t)}`);
}

function checkSlug(s: unknown): Checked<string> {
  return typeof s === "string" && (s === "" || validSlug(s))
    ? ok(s)
    : err(`Invalid location slug: ${show(s)}`);
}

function checkSaved(list: unknown): Checked<string[]> {
  if (!Array.isArray(list)) return err("savedLocations must be a list");
  if (list.length > MAX_SAVED_LOCATIONS) {
    return err(`Too many saved locations (max ${MAX_SAVED_LOCATIONS})`);
  }
  for (const s of list) {
    if (typeof s !== "string" || !validSlug(s)) {
      return err(`Invalid location slug: ${show(s)}`);
    }
  }
  return ok(list as string[]);
}

function checkActivities(list: unknown): Checked<string[]> {
  if (!Array.isArray(list)) return err("selectedActivities must be a list");
  if (list.length > MAX_ACTIVITIES) {
    return err(`Too many activities (max ${MAX_ACTIVITIES})`);
  }
  if (!list.every((a) => typeof a === "string")) {
    return err("selectedActivities must be a list of strings");
  }
  return ok(list as string[]);
}

function checkModel(m: unknown): Checked<string> {
  return typeof m === "string" &&
    (FORECAST_MODELS as readonly string[]).includes(m)
    ? ok(m)
    : err(`Invalid forecast model: ${show(m)}`);
}

function checkBool(name: string, b: unknown): Checked<boolean> {
  return typeof b === "boolean" ? ok(b) : err(`${name} must be true or false`);
}

/** A short, safe rendering of a rejected value for an error detail. */
function show(v: unknown): string {
  if (typeof v === "string") return v.length > 40 ? `${v.slice(0, 40)}...` : v;
  return typeof v;
}

/** A whole preferences object; a missing field takes its default. */
export function validatePreferences(input: unknown): Checked<Preferences> {
  if (input === undefined || input === null)
    return ok({
      ...DEFAULT_PREFERENCES,
      savedLocations: [],
      selectedActivities: [],
    });
  if (!isRecord(input)) return err("preferences must be an object");
  const base: Preferences = {
    ...DEFAULT_PREFERENCES,
    savedLocations: [],
    selectedActivities: [],
  };
  if (has(input, "theme")) {
    const r = checkTheme(input.theme);
    if (!r.ok) return r;
    base.theme = r.value;
  }
  if (has(input, "selectedLocation")) {
    const r = checkSlug(input.selectedLocation);
    if (!r.ok) return r;
    base.selectedLocation = r.value;
  }
  if (has(input, "savedLocations")) {
    const r = checkSaved(input.savedLocations);
    if (!r.ok) return r;
    base.savedLocations = r.value;
  }
  if (has(input, "selectedActivities")) {
    const r = checkActivities(input.selectedActivities);
    if (!r.ok) return r;
    base.selectedActivities = r.value;
  }
  if (has(input, "hasOnboarded")) {
    const r = checkBool("hasOnboarded", input.hasOnboarded);
    if (!r.ok) return r;
    base.hasOnboarded = r.value;
  }
  if (has(input, "selectedForecastModel")) {
    const r = checkModel(input.selectedForecastModel);
    if (!r.ok) return r;
    base.selectedForecastModel = r.value;
  }
  return ok(base);
}

/**
 * A partial update, as the dotted `$set` paths to apply. Only the fields
 * present change (last write wins; an array is replaced, never merged). An
 * empty patch is `Err("No fields to update")`.
 */
export function validatePatch(
  input: unknown,
): Checked<Record<string, unknown>> {
  if (!isRecord(input))
    return err("The body must be a preferences update object");
  const set: Record<string, unknown> = {};
  if (has(input, "theme")) {
    const r = checkTheme(input.theme);
    if (!r.ok) return r;
    set["preferences.theme"] = r.value;
  }
  if (has(input, "selectedLocation")) {
    const r = checkSlug(input.selectedLocation);
    if (!r.ok) return r;
    set["preferences.selectedLocation"] = r.value;
  }
  if (has(input, "savedLocations")) {
    const r = checkSaved(input.savedLocations);
    if (!r.ok) return r;
    set["preferences.savedLocations"] = r.value;
  }
  if (has(input, "selectedActivities")) {
    const r = checkActivities(input.selectedActivities);
    if (!r.ok) return r;
    set["preferences.selectedActivities"] = r.value;
  }
  if (has(input, "hasOnboarded")) {
    const r = checkBool("hasOnboarded", input.hasOnboarded);
    if (!r.ok) return r;
    set["preferences.hasOnboarded"] = r.value;
  }
  if (has(input, "selectedForecastModel")) {
    const r = checkModel(input.selectedForecastModel);
    if (!r.ok) return r;
    set["preferences.selectedForecastModel"] = r.value;
  }
  return Object.keys(set).length === 0 ? err("No fields to update") : ok(set);
}

/** What a stored preferences object reads as: a bad or missing field is its default. */
export function readPreferences(stored: unknown): Preferences {
  const out: Preferences = {
    ...DEFAULT_PREFERENCES,
    savedLocations: [],
    selectedActivities: [],
  };
  if (!isRecord(stored)) return out;
  if (typeof stored.theme === "string") out.theme = stored.theme;
  if (typeof stored.selectedLocation === "string")
    out.selectedLocation = stored.selectedLocation;
  if (Array.isArray(stored.savedLocations)) {
    out.savedLocations = stored.savedLocations.filter(
      (s): s is string => typeof s === "string",
    );
  }
  if (Array.isArray(stored.selectedActivities)) {
    out.selectedActivities = stored.selectedActivities.filter(
      (s): s is string => typeof s === "string",
    );
  }
  if (typeof stored.hasOnboarded === "boolean")
    out.hasOnboarded = stored.hasOnboarded;
  if (typeof stored.selectedForecastModel === "string") {
    out.selectedForecastModel = stored.selectedForecastModel;
  }
  return out;
}

export interface WeatherSnapshot {
  temperature: number | null;
  weatherCode: number | null;
  precipitation: number | null;
  windSpeed: number | null;
  humidity: number | null;
}

const SNAPSHOT_FIELDS = [
  "temperature",
  "weatherCode",
  "precipitation",
  "windSpeed",
  "humidity",
] as const;

/** `{}` (no snapshot was available) or the five fields, each a number or null. */
function checkSnapshot(input: unknown): Checked<Partial<WeatherSnapshot>> {
  if (input === undefined || input === null) return ok({});
  if (!isRecord(input)) return err("weatherSnapshot must be an object");
  const out: Partial<WeatherSnapshot> = {};
  for (const k of SNAPSHOT_FIELDS) {
    const v = input[k];
    if (v === undefined) continue;
    if (v === null) {
      out[k] = null;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    } else {
      return err(`weatherSnapshot.${k} must be a number or null`);
    }
  }
  return ok(out);
}

function checkCoordinate(
  name: string,
  v: unknown,
  limit: number,
): Checked<number | null> {
  if (v === undefined || v === null) return ok(null);
  if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= limit)
    return ok(v);
  return err(`${name} must be a number within +/-${limit}, or null`);
}

export interface NewReport {
  locationSlug: string;
  locationName: string;
  lat: number | null;
  lon: number | null;
  reportType: string;
  severity: string;
  description: string;
  weatherSnapshot: Partial<WeatherSnapshot>;
  reportedBy: string;
  verified: boolean;
}

/** A report to submit. Times, votes and the expiry are the bridge's, never the caller's. */
export function validateReport(input: unknown): Checked<NewReport> {
  if (!isRecord(input)) return err("The body must be a report object");
  const {
    locationSlug,
    locationName,
    reportType,
    severity,
    description,
    reportedBy,
    verified,
  } = input;
  if (typeof locationSlug !== "string" || !validStorageKey(locationSlug)) {
    return err("Invalid location key");
  }
  if (
    typeof locationName !== "string" ||
    locationName.length < 1 ||
    locationName.length > MAX_LOCATION_NAME
  ) {
    return err(`locationName must be 1 to ${MAX_LOCATION_NAME} characters`);
  }
  if (
    typeof reportType !== "string" ||
    !(REPORT_TYPES as readonly string[]).includes(reportType)
  ) {
    return err(
      `Invalid report type. Must be one of: ${[...REPORT_TYPES].sort().join(", ")}`,
    );
  }
  if (
    typeof severity !== "string" ||
    !(SEVERITIES as readonly string[]).includes(severity)
  ) {
    return err("Invalid severity. Must be one of: mild, moderate, severe");
  }
  const desc =
    description === undefined || description === null ? "" : description;
  if (typeof desc !== "string") return err("description must be text");
  if ([...desc].length > MAX_DESCRIPTION) {
    return err(`Description too long (max ${MAX_DESCRIPTION} characters)`);
  }
  if (typeof reportedBy !== "string" || !validVoter(reportedBy)) {
    return err("Invalid reporter id");
  }
  if (typeof verified !== "boolean")
    return err("verified must be true or false");
  const lat = checkCoordinate("lat", input.lat, 90);
  if (!lat.ok) return lat;
  const lon = checkCoordinate("lon", input.lon, 180);
  if (!lon.ok) return lon;
  const snap = checkSnapshot(input.weatherSnapshot);
  if (!snap.ok) return snap;
  return ok({
    locationSlug,
    locationName,
    lat: lat.value,
    lon: lon.value,
    reportType,
    severity,
    description: desc,
    weatherSnapshot: snap.value,
    reportedBy,
    verified,
  });
}

/** How long a report lives, by severity: 24, 48 or 72 hours. */
export function ttlSeconds(severity: string): number {
  switch (severity) {
    case "mild":
      return 86_400;
    case "severe":
      return 259_200;
    default:
      return 172_800;
  }
}

export interface ListQuery {
  keys: string[];
  hours: number;
  limit: number;
}

/** `slug` (repeatable, 1 to 4), `hours` (clamped 1..72, default 24), `limit` (clamped 1..20, default 20). */
export function validateListQuery(params: URLSearchParams): Checked<ListQuery> {
  const keys = params.getAll("slug");
  if (keys.length < 1 || keys.length > MAX_LIST_KEYS) {
    return err(`Give 1 to ${MAX_LIST_KEYS} slug parameters`);
  }
  if (!keys.every(validStorageKey)) return err("Invalid location key");
  const int = (name: string, dflt: number): Checked<number> => {
    const raw = params.get(name);
    if (raw === null || raw === "") return ok(dflt);
    return /^-?\d{1,6}$/.test(raw)
      ? ok(Number(raw))
      : err(`${name} must be an integer`);
  };
  const hours = int("hours", 24);
  if (!hours.ok) return hours;
  const limit = int("limit", LIST_LIMIT);
  if (!limit.ok) return limit;
  return ok({
    keys: [...new Set(keys)],
    hours: Math.min(Math.max(hours.value, 1), 72),
    limit: Math.min(Math.max(limit.value, 1), LIST_LIMIT),
  });
}

/** An upvote: the report's ObjectId (24 hex) and the voter's anonymous id. */
export function validateUpvote(
  input: unknown,
): Checked<{ reportId: string; voter: string }> {
  if (!isRecord(input)) return err("The body must be an upvote object");
  if (typeof input.reportId !== "string" || !validReportId(input.reportId)) {
    return err("Invalid report ID");
  }
  if (typeof input.voter !== "string" || !validVoter(input.voter)) {
    return err("Invalid voter id");
  }
  return ok({ reportId: input.reportId.toLowerCase(), voter: input.voter });
}
