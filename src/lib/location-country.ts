/**
 * Country for any place on Earth — the platform geography (places.placesGeo)
 * stores 54 African countries, so a place outside them (London, Tokyo, a
 * farm in Iceland, a spot in the open ocean) often reaches the page with no
 * country at all. The forecast always carries the place's IANA time zone,
 * and a zone names exactly one country, so the page can fill the gap with no
 * extra request.
 */

import { COUNTRIES } from "./countries";
import type { WeatherLocation } from "./locations";
import { countryForTimezone } from "./timezone-country";

let displayNames: Intl.DisplayNames | null | undefined;

function regionNames(): Intl.DisplayNames | null {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      displayNames = null;
    }
  }
  return displayNames;
}

/**
 * English name for an ISO 3166-1 alpha-2 code: the curated `COUNTRIES` name
 * first (keeps African names exactly as they were), then the runtime's CLDR
 * region names (every ISO country), else the code itself.
 */
export function countryDisplayName(code: string | null | undefined): string {
  const cc = (code ?? "").trim().toUpperCase();
  if (!cc) return "";
  const curated = COUNTRIES.find((c) => c.code.toUpperCase() === cc);
  if (curated) return curated.name;
  if (!/^[A-Z]{2}$/.test(cc) || cc === "ZZ") return cc === "ZZ" ? "" : cc;
  try {
    const name = regionNames()?.of(cc);
    // CLDR echoes unknown codes back unchanged.
    if (name && name.toUpperCase() !== cc) return name;
  } catch {
    // Invalid code for this runtime — fall through.
  }
  return cc;
}

/**
 * Fill or correct a location's country from the forecast's time zone.
 *
 * - No country yet → take the zone's country (province stays as is).
 * - Country borrowed from a nearby seed (`regionApproximate`) and the zone
 *   disagrees → the zone wins, and the borrowed province goes with the
 *   borrowed country (a Moroccan province on a Spanish spot is wrong).
 * - A country we actually know is never overruled.
 * - Zones that name no country (`Etc/GMT+9` over the ocean, `UTC`) change
 *   nothing.
 */
export function reconcileCountry<T extends WeatherLocation>(
  location: T,
  timezone: string | null | undefined,
): T {
  const zoneCountry = countryForTimezone(timezone);
  if (!zoneCountry) return location;
  const current = (location.country ?? "").toUpperCase();
  if (!current) return { ...location, country: zoneCountry };
  if (location.regionApproximate && current !== zoneCountry) {
    return { ...location, country: zoneCountry, province: "" };
  }
  return location;
}

/** "Name, Province, Country" without empty parts or a repeated name. */
export function placeLine(...parts: (string | null | undefined)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const part = (raw ?? "").trim();
    if (!part || seen.has(part.toLowerCase())) continue;
    seen.add(part.toLowerCase());
    out.push(part);
  }
  return out.join(", ");
}
