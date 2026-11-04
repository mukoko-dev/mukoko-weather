/**
 * The season for a country on a date, with no database (issue #452).
 *
 * `getSeasonForDate` (db.ts) reads `weather.seasons`, a collection that
 * `POST /api/db-init` fills from `seed-seasons.ts`. A page whose shell must
 * not wait on data cannot wait on that read, and the seed is the same table,
 * prebuilt: this answers from it, in the same way (the first season of the
 * country whose months include the date's month), and falls back to the
 * hemisphere default (`getDefaultSeason`) exactly as the database read does
 * for a country it has no rows for.
 *
 * The one difference: rows that exist only in the database (at the time of
 * writing four for GB, made by the retired AI season enrichment) are not in
 * the seed, so those countries get the hemisphere default here.
 *
 * Server-side: it pulls in the seed table (about 600 lines), which the
 * browser should not download. Pure otherwise.
 */

import { SEASONS } from "./seed-seasons";
import { getDefaultSeason, type Season } from "./weather";

/** Seed rows by country, built once. */
const BY_COUNTRY = new Map<string, typeof SEASONS>();
for (const row of SEASONS) {
  const rows = BY_COUNTRY.get(row.countryCode);
  if (rows) rows.push(row);
  else BY_COUNTRY.set(row.countryCode, [row]);
}

export function localSeason(
  date: Date,
  countryCode: string,
  lat: number,
): Season {
  const code = (countryCode ?? "").trim().toUpperCase();
  const month = date.getMonth() + 1;
  const row = code
    ? BY_COUNTRY.get(code)?.find((s) => s.months.includes(month))
    : undefined;
  if (row) {
    return {
      name: row.name,
      localName: row.localName || row.name,
      description: row.description,
    };
  }
  return getDefaultSeason(date, lat);
}
