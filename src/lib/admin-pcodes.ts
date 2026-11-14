/**
 * Admin-1 P-codes for the places that need one to pick a region-specific
 * name (season names, see season-names.ts).
 *
 * The codes are OCHA COD-AB P-codes, copied from `agriculture.adminAreas`
 * (HDX cod-ab-zwe, version v01, CC-BY-IGO, retrieved 2026-10-29), never
 * guessed. A country is listed only once its codes were read from there; for
 * any other country `adminPcodeFor` answers null and the caller falls back to
 * language, then English.
 */

const ZW_ADMIN1: Record<string, string> = {
  bulawayo: "ZW10",
  manicaland: "ZW11",
  "mashonaland central": "ZW12",
  "mashonaland east": "ZW13",
  "mashonaland west": "ZW14",
  "matabeleland north": "ZW15",
  "matabeleland south": "ZW16",
  midlands: "ZW17",
  masvingo: "ZW18",
  harare: "ZW19",
};

const BY_COUNTRY: Record<string, Record<string, string>> = { ZW: ZW_ADMIN1 };

/** "Matabeleland North", "matabeleland-north" and "Harare Province" all key alike. */
function key(province: string): string {
  return province
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+province$/, "")
    .replace(/\s+/g, " ");
}

/**
 * The admin-1 P-code of a province, or null when the country is not in the
 * table or the province is not one of its provinces. Pass null for a
 * province that is only borrowed from a neighbour (`regionApproximate`): a
 * place's name must never come from a region it is not in.
 */
export function adminPcodeFor(
  countryCode: string | null | undefined,
  province: string | null | undefined,
): string | null {
  if (!countryCode || !province) return null;
  const table = BY_COUNTRY[countryCode.trim().toUpperCase()];
  return table?.[key(province)] ?? null;
}

/** Every P-code the table knows, for tests that check seed `regions`. */
export function knownAdminPcodes(countryCode: string): string[] {
  return Object.values(BY_COUNTRY[countryCode.toUpperCase()] ?? {});
}

/**
 * The admin-1 P-code of a place, null when it cannot be told. A province
 * borrowed from a neighbouring seed (`regionApproximate`) is not the
 * place's own, so it gives no code.
 */
export function placeAdminPcode(place: {
  country?: string | null;
  province?: string | null;
  regionApproximate?: boolean | null;
}): string | null {
  if (place.regionApproximate) return null;
  return adminPcodeFor(place.country, place.province);
}
