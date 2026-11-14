/**
 * Which name a season is called, for where the person is.
 *
 * Season names change by region, not by country, and the weather does not
 * lock in a language: a place is served the name used where it is. The order
 * is the owner's (2026-11-14): the user's location first, then the user's
 * language, then English.
 *
 *   1. a name for the user's admin-1 region (`regions` holds OCHA COD-AB
 *      P-codes, as in `agriculture.adminAreas`);
 *   2. a name in the user's language;
 *   3. the English name.
 *
 * A row that has no `names` yet is read the old way (`localName`, then
 * `name`), so countries not yet converted keep working.
 *
 * Pure and dependency-free (type import only), so it is safe in a client
 * bundle and for the seed generator.
 */

import type { SeasonName } from "./seed-seasons";

export interface SeasonNameRow {
  name: string;
  /** Deprecated single local name; read only when `names` is absent. */
  localName?: string;
  names?: SeasonName[];
}

export interface SeasonNameContext {
  /** The place's admin-1 P-code, when known (`adminPcodeFor`). */
  region?: string | null;
  /** The person's language, a BCP 47 tag ("sn", "en-ZW"). */
  lang?: string | null;
}

const primary = (tag: string): string => tag.trim().toLowerCase().split("-")[0];

export function resolveSeasonName(
  row: SeasonNameRow,
  ctx: SeasonNameContext = {},
): string {
  const names = row.names;
  if (!names || names.length === 0) return row.localName || row.name;

  const region = ctx.region?.trim().toUpperCase() || "";
  if (region) {
    const hit = names.find((n) =>
      n.regions?.some((r) => r.toUpperCase() === region),
    );
    if (hit) return hit.name;
  }

  const lang = ctx.lang ? primary(ctx.lang) : "";
  if (lang && lang !== "en") {
    // A name kept for other regions is not the user's even if the language
    // matches, so when the region is known it is skipped; with no region
    // known, the language alone decides.
    const hit = names.find(
      (n) =>
        primary(n.lang) === lang &&
        (!region || !n.regions || !n.regions.length),
    );
    if (hit) return hit.name;
  }

  const english = names.find(
    (n) => primary(n.lang) === "en" && !(n.regions && n.regions.length),
  );
  return english?.name ?? row.name;
}

/**
 * How a season is written for a person: "Zhizha (Summer rains)" when it has a
 * name apart from the English one, else just the English name.
 */
export function seasonLabel(season: {
  name: string;
  localName?: string | null;
}): string {
  const local = season.localName?.trim();
  return local && local !== season.name
    ? `${local} (${season.name})`
    : season.name;
}
