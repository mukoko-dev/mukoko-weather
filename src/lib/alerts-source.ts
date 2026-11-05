/**
 * Where the alerts get their data on the device (mukoko-dev/mukoko-weather#289):
 * the last good forecasts in the device store (`weather_places`, RxDB) and the
 * community reports the page already fetched into the shared Worker read
 * store. Nothing here asks the network: no request per saved place, no
 * polling. The rules are in `alerts.ts` (pure); this file only gathers.
 *
 * Which places: the one on screen, the Home place, My Location (the place last
 * shown at `/`) and the saved places, in that order, without repeats.
 */

import {
  collectAlerts,
  type AlertPlace,
  type AlertsResult,
  type CommunityReportLike,
} from "./alerts";
import { laneChipName } from "./location-pager";
import { REPORT_WINDOW_HOURS } from "./reports-api";
import { readPlaces } from "./rxdb/weather-places";
import { workerData } from "./worker-data";

/** The most places looked at: the saved list's cap plus the on-screen, Home and My Location places. */
export const MAX_ALERT_SOURCE_PLACES = 13;

export interface AlertPlaceSlugInput {
  selectedLocation?: string | null;
  homeLocation?: string | null;
  /** The place last shown at `/` (My Location), from `LAST_HOME_PLACE_KEY`. */
  lastHomePlace?: string | null;
  savedLocations?: readonly string[];
}

/** The places whose alerts the bell lists, in order, without repeats. */
export function alertPlaceSlugs(input: AlertPlaceSlugInput): string[] {
  const out: string[] = [];
  const add = (slug: string | null | undefined) => {
    if (
      typeof slug === "string" &&
      slug.length > 0 &&
      !out.includes(slug) &&
      out.length < MAX_ALERT_SOURCE_PLACES
    ) {
      out.push(slug);
    }
  };
  add(input.selectedLocation);
  add(input.homeLocation);
  add(input.lastHomePlace);
  for (const slug of input.savedLocations ?? []) add(slug);
  return out;
}

/**
 * The reports the page already fetched for a place (the report lane and the
 * recent-reports card share one read), or null when none was fetched in this
 * tab. `peekSettled` never starts a request.
 */
export function peekReports(
  slug: string,
): readonly CommunityReportLike[] | null {
  const settled = workerData.peekSettled<{
    reports?: CommunityReportLike[];
  }>("reports", { location: slug, hours: REPORT_WINDOW_HOURS });
  if (!settled?.ok || !settled.data) return null;
  return Array.isArray(settled.data.reports) ? settled.data.reports : [];
}

export interface AlertNames {
  labels?: Readonly<Record<string, string>>;
  names?: Readonly<Record<string, string>>;
}

/** What is held for each place right now: its stored forecast and its reports. */
export async function loadAlertPlaces(
  slugs: readonly string[],
  names: AlertNames = {},
  now: number = Date.now(),
): Promise<AlertPlace[]> {
  const stored = await readPlaces(slugs, now);
  const bySlug = new Map(stored.map((p) => [p.slug, p]));
  return slugs.map((slug): AlertPlace => {
    const place = bySlug.get(slug);
    return {
      slug,
      name:
        place?.payload.location.name ??
        laneChipName(slug, names.labels, names.names),
      weather: place?.payload.weather ?? null,
      fetchedAt: place?.fetchedAt ?? null,
      reports: peekReports(slug),
    };
  });
}

/** The whole read: gather, then apply the rules. */
export async function loadAlerts(
  slugs: readonly string[],
  names: AlertNames = {},
  now: Date = new Date(),
): Promise<AlertsResult> {
  const places = await loadAlertPlaces(slugs, names, now.getTime());
  return collectAlerts(places, now);
}
