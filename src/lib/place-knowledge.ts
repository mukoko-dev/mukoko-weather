/**
 * Client for the stored place-knowledge profile (`GET /api/py/locations/profile`,
 * mukoko-dev/mukoko-weather#277) and the pure formatting behind the
 * "About this place" rows.
 *
 * The profile is slow-changing (seasons, crop calendar, climate normals,
 * Köppen zone), and the card remounts often (LazySection unloads it
 * off-screen), so results are kept in memory per slug for 30 minutes and
 * concurrent requests share one fetch. Anything derived or unverified is
 * labelled "estimated": never shown as a local fact.
 */

export interface ProfileMonthlyNormal {
  month: number;
  meanHighC: number | null;
  meanLowC: number | null;
  precipMm: number | null;
}

export interface ProfileCropPhase {
  crop: string;
  cropLabel: string;
  season: string | null;
  phaseLabel: string;
  nextPhaseLabel: string;
  /** ISO date. */
  nextPhaseOn: string;
}

export interface PlaceProfile {
  climate: { koppen: { code: string; label: string } | null };
  agriculture: {
    derived: { months: number[]; basis: string } | null;
  } | null;
  current: {
    month: number;
    season: {
      name: string;
      localName: string | null;
      verified: boolean;
    } | null;
    nextSeason: {
      name: string;
      localName: string | null;
      startsOn: string;
    } | null;
    normalsThisMonth: ProfileMonthlyNormal | null;
    cropPhases: ProfileCropPhase[];
    inDerivedGrowingWindow: boolean | null;
  } | null;
}

export interface ProfileRow {
  label: string;
  value: string;
}

export const PLACE_PROFILE_TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 50;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** The slug first; the coordinates let the server place a spot it cannot resolve by name. */
export function placeProfileUrl(
  slug: string,
  lat?: number,
  lon?: number,
): string {
  const params = new URLSearchParams({ slug });
  if (typeof lat === "number" && typeof lon === "number") {
    params.set("lat", lat.toFixed(4));
    params.set("lon", lon.toFixed(4));
  }
  return `/api/py/locations/profile?${params.toString()}`;
}

const cache = new Map<string, { profile: PlaceProfile; at: number }>();
const inflight = new Map<string, Promise<PlaceProfile>>();

/** Cached profile for a slug, or undefined when absent or stale. */
export function peekPlaceProfile(
  slug: string,
  now = Date.now(),
): PlaceProfile | undefined {
  const hit = cache.get(slug);
  if (!hit) return undefined;
  if (now - hit.at > PLACE_PROFILE_TTL_MS) {
    cache.delete(slug);
    return undefined;
  }
  return hit.profile;
}

/**
 * Fetch once (deduplicated) and cache. Rejects on HTTP errors and on a body
 * that is not a profile, so callers render nothing rather than a half row.
 */
export function fetchPlaceProfile(
  slug: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  coords?: { lat: number; lon: number },
): Promise<PlaceProfile> {
  const cached = peekPlaceProfile(slug);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(slug);
  if (pending) return pending;
  const request = fetcher(placeProfileUrl(slug, coords?.lat, coords?.lon), {
    signal,
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as PlaceProfile;
      if (!json || typeof json !== "object" || !json.current) {
        throw new Error("not a profile");
      }
      if (cache.size >= MAX_ENTRIES) cache.clear();
      cache.set(slug, { profile: json, at: Date.now() });
      return json;
    })
    .finally(() => inflight.delete(slug));
  inflight.set(slug, request);
  return request;
}

/** Test hook. */
export function resetPlaceProfileCache(): void {
  cache.clear();
  inflight.clear();
}

/** "2026-11-01" → "1 Nov". */
export function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return "";
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]?.slice(0, 3) ?? ""}`.trim();
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function monthRange(months: number[]): string {
  if (months.length === 0) return "";
  const set = new Set(months);
  // First month of the (possibly year-wrapping) run: the one whose
  // predecessor is not in the set.
  const first =
    [...set].find((m) => !set.has(((m + 10) % 12) + 1)) ?? Math.min(...set);
  const last = ((first - 1 + set.size - 1) % 12) + 1;
  const short = (m: number) => MONTHS[m - 1].slice(0, 3);
  return set.size === 1 ? short(first) : `${short(first)}–${short(last)}`;
}

/**
 * The rows shown under "About {place}": climate zone, what is typical this
 * month, the next season, and the crop calendar (or an estimated growing
 * window where no local calendar exists). Derived values say "estimated".
 * Returns [] when there is nothing to show.
 */
export function profileRows(profile: PlaceProfile | null): ProfileRow[] {
  const cur = profile?.current;
  if (!profile || !cur) return [];
  const rows: ProfileRow[] = [];

  const koppen = profile.climate?.koppen;
  if (koppen) {
    rows.push({
      label: "Climate zone",
      value: `${capitalise(koppen.label)} (${koppen.code}), estimated`,
    });
  }

  const n = cur.normalsThisMonth;
  if (n && n.meanHighC !== null && n.meanLowC !== null) {
    const rain =
      n.precipMm !== null ? `, ${Math.round(n.precipMm)} mm of rain` : "";
    rows.push({
      label: `Typical in ${MONTHS[cur.month - 1] ?? "this month"}`,
      value: `${Math.round(n.meanHighC)}° high, ${Math.round(n.meanLowC)}° low${rain}`,
    });
  }

  if (cur.nextSeason) {
    const name = cur.nextSeason.localName ?? cur.nextSeason.name;
    const hedge = cur.season && !cur.season.verified ? ", estimated" : "";
    rows.push({
      label: "Next season",
      value: `${name} from ${shortDate(cur.nextSeason.startsOn)}${hedge}`,
    });
  }

  if (cur.cropPhases.length > 0) {
    const value = cur.cropPhases
      .slice(0, 2)
      .map((p) => {
        const season = p.season ? ` (${p.season.toLowerCase()})` : "";
        return `${p.cropLabel}${season}: ${p.phaseLabel.toLowerCase()}, ${p.nextPhaseLabel.toLowerCase()} from ${shortDate(p.nextPhaseOn)}`;
      })
      .join("; ");
    rows.push({ label: "Crop calendar", value });
  } else if (
    profile.agriculture?.derived &&
    profile.agriculture.derived.months.length > 0
  ) {
    const window = monthRange(profile.agriculture.derived.months);
    const state =
      cur.inDerivedGrowingWindow === null
        ? ""
        : cur.inDerivedGrowingWindow
          ? ", now inside it"
          : ", now outside it";
    rows.push({
      label: "Growing window",
      value: `${window}${state}, estimated`,
    });
  }

  return rows;
}
