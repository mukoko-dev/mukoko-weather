/**
 * Client-side loaders for the activity catalogue and its categories.
 *
 * Both lists change only on deployment (db-init), so each is cached in memory
 * for 10 minutes and concurrent callers share one in-flight request. Failures
 * resolve to an empty array, so callers keep their seeded/static fallback by
 * checking `length` before replacing it.
 */

import type { Activity } from "./activities";
import type { ActivityCategoryDoc } from "./seed-categories";
import { fetchJson } from "./fetch-json";

const CATALOGUE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

interface ListCache<T> {
  value: T[] | null;
  at: number;
  inFlight: Promise<T[]> | null;
}

function newListCache<T>(): ListCache<T> {
  return { value: null, at: 0, inFlight: null };
}

function loadList<T>(
  cache: ListCache<T>,
  url: string,
  key: "activities" | "categories",
): Promise<T[]> {
  if (cache.value && Date.now() - cache.at < CATALOGUE_CACHE_TTL) {
    return Promise.resolve(cache.value);
  }
  if (cache.inFlight) return cache.inFlight;

  cache.inFlight = fetchJson<Record<string, unknown>>(url)
    .then((data) => {
      const list = data?.[key];
      if (Array.isArray(list) && list.length > 0) {
        cache.value = list as T[];
        cache.at = Date.now();
        return cache.value;
      }
      return [];
    })
    .finally(() => {
      cache.inFlight = null;
    });
  return cache.inFlight;
}

const activitiesCache = newListCache<Activity>();
const categoriesCache = newListCache<ActivityCategoryDoc>();

/** All activities from `/api/py/activities`. `[]` when unavailable. */
export function fetchActivities(): Promise<Activity[]> {
  return loadList(activitiesCache, "/api/py/activities", "activities");
}

/** Activity categories (with mineral styles) from `/api/py/activities?mode=categories`. `[]` when unavailable. */
export function fetchActivityCategories(): Promise<ActivityCategoryDoc[]> {
  return loadList(
    categoriesCache,
    "/api/py/activities?mode=categories",
    "categories",
  );
}

/** Test helper — drop cached catalogues and in-flight requests. */
export function resetActivitiesClientCache(): void {
  for (const cache of [activitiesCache, categoriesCache]) {
    cache.value = null;
    cache.at = 0;
    cache.inFlight = null;
  }
}
