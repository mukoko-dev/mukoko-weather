/**
 * Server helpers for the place pages (`/` and `/[location]`).
 *
 * These pages send the shell and the place — never weather. The visitor's own
 * browser fetches the forecast (own IP, own rate budget), painted over the
 * stored copy. Nothing here may call the weather Worker or Open-Meteo:
 * `src/app/place-pages-no-weather.test.ts` fails if it does.
 */
import { cache } from "react";
import { getSeasonForDate } from "@/lib/db";
import { getDefaultSeason } from "@/lib/weather";

export type Season = Awaited<ReturnType<typeof getSeasonForDate>>;

/**
 * Season for a country on today's date, deduplicated per request. Pages and
 * `generateMetadata` share it, so one request reads the season once.
 */
export const getCachedSeason = cache((countryCode: string, lat: number = 0) =>
  getSeasonForDate(new Date(), countryCode, lat),
);

/**
 * Longest the page waits for the database season (Mongo can be cold for
 * seconds). Past it the hemisphere's default season is used, which is what
 * the database answer would almost always be.
 */
export const SEED_SEASON_BUDGET_MS = 800;

/** The season for a country and latitude, never later than the budget. */
export async function seasonWithinBudget(
  countryCode: string,
  lat: number,
  budgetMs: number = SEED_SEASON_BUDGET_MS,
): Promise<Season> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fallback = new Promise<Season>((resolve) => {
    timer = setTimeout(
      () => resolve(getDefaultSeason(new Date(), lat)),
      budgetMs,
    );
  });
  try {
    return await Promise.race([
      getCachedSeason(countryCode, lat).catch(() =>
        getDefaultSeason(new Date(), lat),
      ),
      fallback,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
