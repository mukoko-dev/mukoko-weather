/**
 * Maps location slugs to ICAO airport codes.
 * Only locations with active reporting airports are included.
 * Returns null for locations without aviation data.
 */

const ICAO_MAP: Record<string, string> = {
  // Zimbabwe
  harare: "FVHA",
  bulawayo: "FVBU",
  "victoria-falls": "FVFA",
  masvingo: "FVMV",
  gweru: "FVGW",
  mutare: "FVMU",
  kariba: "FVKB",
  "hwange-national-park": "FVWN",
  kwekwe: "FVKK",
  beitbridge: "FVBB",
  bindura: "FVBD",
  chinhoyi: "FVCH",
  "buffalo-range": "FVBR",

  // Africa
  "nairobi-ke": "HKJK",
  "lagos-ng": "DNMM",
  "cairo-eg": "HECA",
  "johannesburg-za": "FAJS",
  "cape-town-za": "FACT",
  "dar-es-salaam-tz": "HTDA",
  "addis-ababa-et": "HAAB",
  "accra-gh": "DGAA",
  "kampala-ug": "HUEN",
  "lusaka-zm": "FLLS",
  "maputo-mz": "FQMA",
  "kigali-rw": "HRYR",
  "dakar-sn": "GOOY",
  "abidjan-ci": "DIAP",
  "douala-cm": "FKKD",
  "antananarivo-mg": "FMMI",
  "mauritius-mu": "FIMP",

  // ASEAN
  "bangkok-th": "VTBS",
  "singapore-sg": "WSSS",
  "kuala-lumpur-my": "WMKK",
  "jakarta-id": "WIII",
  "manila-ph": "RPLL",
  "dhaka-bd": "VGHS",
  "colombo-lk": "VCBI",
};

/** Returns the ICAO airport code for a location slug, or null if not available. */
export function getIcaoForSlug(slug: string): string | null {
  return ICAO_MAP[slug] ?? null;
}
