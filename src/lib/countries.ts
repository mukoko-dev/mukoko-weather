/**
 * Country and province data for mukoko weather.
 *
 * Design: MongoDB is the source of truth. This file provides the initial seed.
 * Countries and provinces grow organically as locations are added via geocoding.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Country {
  code: string;       // ISO 3166-1 alpha-2 (e.g. "ZW")
  name: string;       // "Zimbabwe"
  region: string;     // "Southern Africa"
  /**
   * Set to `true` in seed data to signal that this country is a valid target
   * for community-submitted locations and will appear in explore pages once it
   * has at least one location in MongoDB. `getAllCountries()` filters by actual
   * location presence, so this flag is currently informational only.
   */
  supported: boolean;
}

export interface Province {
  slug: string;        // "mashonaland-west-zw"
  name: string;        // "Mashonaland West"
  countryCode: string; // "ZW"
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a flag emoji from an ISO 3166-1 alpha-2 country code.
 * Uses Unicode Regional Indicator Symbol Letters — no storage needed.
 */
export function getFlagEmoji(code: string): string {
  return [...code.toUpperCase()]
    .map((c) => String.fromCodePoint(c.charCodeAt(0) + 127397))
    .join("");
}

/**
 * Generate a URL-safe province slug by combining the province name and
 * lowercase country code. Uses the same stripping logic as generateSlug().
 */
export function generateProvinceSlug(name: string, countryCode: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return `${base}-${countryCode.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Country seed data — 54 AU member states + 8 Indian Ocean territories + 10 ASEAN
// ---------------------------------------------------------------------------

export const COUNTRIES: Country[] = [
  // ── East Africa ──────────────────────────────────────────────────────────
  { code: "BI", name: "Burundi",                        region: "East Africa",     supported: true },
  { code: "DJ", name: "Djibouti",                       region: "East Africa",     supported: true },
  { code: "ER", name: "Eritrea",                        region: "East Africa",     supported: true },
  { code: "ET", name: "Ethiopia",                       region: "East Africa",     supported: true },
  { code: "KE", name: "Kenya",                          region: "East Africa",     supported: true },
  { code: "KM", name: "Comoros",                        region: "East Africa",     supported: true },
  { code: "MG", name: "Madagascar",                     region: "East Africa",     supported: true },
  { code: "MU", name: "Mauritius",                      region: "East Africa",     supported: true },
  { code: "MW", name: "Malawi",                         region: "East Africa",     supported: true },
  { code: "MZ", name: "Mozambique",                     region: "East Africa",     supported: true },
  { code: "RW", name: "Rwanda",                         region: "East Africa",     supported: true },
  { code: "SC", name: "Seychelles",                     region: "East Africa",     supported: true },
  { code: "SO", name: "Somalia",                        region: "East Africa",     supported: true },
  { code: "SS", name: "South Sudan",                    region: "East Africa",     supported: true },
  { code: "TZ", name: "Tanzania",                       region: "East Africa",     supported: true },
  { code: "UG", name: "Uganda",                         region: "East Africa",     supported: true },

  // ── Southern Africa ───────────────────────────────────────────────────────
  { code: "AO", name: "Angola",                         region: "Southern Africa", supported: true },
  { code: "ZM", name: "Zambia",                         region: "Southern Africa", supported: true },
  { code: "ZW", name: "Zimbabwe",                       region: "Southern Africa", supported: true },
  { code: "BW", name: "Botswana",                       region: "Southern Africa", supported: true },
  { code: "LS", name: "Lesotho",                        region: "Southern Africa", supported: true },
  { code: "NA", name: "Namibia",                        region: "Southern Africa", supported: true },
  { code: "SZ", name: "Eswatini",                       region: "Southern Africa", supported: true },
  { code: "ZA", name: "South Africa",                   region: "Southern Africa", supported: true },

  // ── West Africa ──────────────────────────────────────────────────────────
  { code: "BF", name: "Burkina Faso",                   region: "West Africa",     supported: true },
  { code: "BJ", name: "Benin",                          region: "West Africa",     supported: true },
  { code: "CI", name: "Cote d'Ivoire",                  region: "West Africa",     supported: true },
  { code: "CV", name: "Cabo Verde",                     region: "West Africa",     supported: true },
  { code: "GH", name: "Ghana",                          region: "West Africa",     supported: true },
  { code: "GM", name: "Gambia",                         region: "West Africa",     supported: true },
  { code: "GN", name: "Guinea",                         region: "West Africa",     supported: true },
  { code: "GW", name: "Guinea-Bissau",                  region: "West Africa",     supported: true },
  { code: "LR", name: "Liberia",                        region: "West Africa",     supported: true },
  { code: "ML", name: "Mali",                           region: "West Africa",     supported: true },
  { code: "MR", name: "Mauritania",                     region: "West Africa",     supported: true },
  { code: "NE", name: "Niger",                          region: "West Africa",     supported: true },
  { code: "NG", name: "Nigeria",                        region: "West Africa",     supported: true },
  { code: "SL", name: "Sierra Leone",                   region: "West Africa",     supported: true },
  { code: "SN", name: "Senegal",                        region: "West Africa",     supported: true },
  { code: "TG", name: "Togo",                           region: "West Africa",     supported: true },

  // ── Central Africa ────────────────────────────────────────────────────────
  { code: "CD", name: "DR Congo",                       region: "Central Africa",  supported: true },
  { code: "CF", name: "Central African Republic",       region: "Central Africa",  supported: true },
  { code: "CG", name: "Republic of Congo",              region: "Central Africa",  supported: true },
  { code: "CM", name: "Cameroon",                       region: "Central Africa",  supported: true },
  { code: "GA", name: "Gabon",                          region: "Central Africa",  supported: true },
  { code: "GQ", name: "Equatorial Guinea",              region: "Central Africa",  supported: true },
  { code: "ST", name: "Sao Tome and Principe",          region: "Central Africa",  supported: true },
  { code: "TD", name: "Chad",                           region: "Central Africa",  supported: true },

  // ── North Africa ──────────────────────────────────────────────────────────
  { code: "DZ", name: "Algeria",                        region: "North Africa",    supported: true },
  { code: "EG", name: "Egypt",                          region: "North Africa",    supported: true },
  { code: "LY", name: "Libya",                          region: "North Africa",    supported: true },
  { code: "MA", name: "Morocco",                        region: "North Africa",    supported: true },
  { code: "SD", name: "Sudan",                          region: "North Africa",    supported: true },
  { code: "TN", name: "Tunisia",                        region: "North Africa",    supported: true },

  // ── Indian Ocean territories ─────────────────────────────────────────────
  { code: "RE", name: "Reunion",                        region: "Indian Ocean",    supported: true },
  { code: "YT", name: "Mayotte",                        region: "Indian Ocean",    supported: true },

  // ── ASEAN ─────────────────────────────────────────────────────────────────
  { code: "BN", name: "Brunei",                         region: "ASEAN",           supported: true },
  { code: "ID", name: "Indonesia",                      region: "ASEAN",           supported: true },
  { code: "KH", name: "Cambodia",                       region: "ASEAN",           supported: true },
  { code: "LA", name: "Laos",                           region: "ASEAN",           supported: true },
  { code: "MM", name: "Myanmar",                        region: "ASEAN",           supported: true },
  { code: "MY", name: "Malaysia",                       region: "ASEAN",           supported: true },
  { code: "PH", name: "Philippines",                    region: "ASEAN",           supported: true },
  { code: "SG", name: "Singapore",                      region: "ASEAN",           supported: true },
  { code: "TH", name: "Thailand",                       region: "ASEAN",           supported: true },
  { code: "TL", name: "Timor-Leste",                    region: "ASEAN",           supported: true },
  { code: "VN", name: "Vietnam",                        region: "ASEAN",           supported: true },
];

// ---------------------------------------------------------------------------
// Province seed data
// ---------------------------------------------------------------------------

export const PROVINCES: Province[] = [
  // ── Zimbabwe (10 provinces) ───────────────────────────────────────────────
  { slug: "harare-zw",                  name: "Harare",                countryCode: "ZW" },
  { slug: "bulawayo-zw",                name: "Bulawayo",              countryCode: "ZW" },
  { slug: "manicaland-zw",              name: "Manicaland",            countryCode: "ZW" },
  { slug: "mashonaland-central-zw",     name: "Mashonaland Central",   countryCode: "ZW" },
  { slug: "mashonaland-east-zw",        name: "Mashonaland East",      countryCode: "ZW" },
  { slug: "mashonaland-west-zw",        name: "Mashonaland West",      countryCode: "ZW" },
  { slug: "masvingo-zw",                name: "Masvingo",              countryCode: "ZW" },
  { slug: "matabeleland-north-zw",      name: "Matabeleland North",    countryCode: "ZW" },
  { slug: "matabeleland-south-zw",      name: "Matabeleland South",    countryCode: "ZW" },
  { slug: "midlands-zw",                name: "Midlands",              countryCode: "ZW" },

  // ── Kenya ─────────────────────────────────────────────────────────────────
  { slug: "nairobi-county-ke",          name: "Nairobi County",        countryCode: "KE" },
  { slug: "mombasa-county-ke",          name: "Mombasa County",        countryCode: "KE" },
  { slug: "kisumu-county-ke",           name: "Kisumu County",         countryCode: "KE" },
  { slug: "nakuru-county-ke",           name: "Nakuru County",         countryCode: "KE" },
  { slug: "uasin-gishu-county-ke",      name: "Uasin Gishu County",    countryCode: "KE" },

  // ── Tanzania ──────────────────────────────────────────────────────────────
  { slug: "dar-es-salaam-region-tz",    name: "Dar es Salaam Region",  countryCode: "TZ" },
  { slug: "dodoma-region-tz",           name: "Dodoma Region",         countryCode: "TZ" },
  { slug: "mwanza-region-tz",           name: "Mwanza Region",         countryCode: "TZ" },
  { slug: "arusha-region-tz",           name: "Arusha Region",         countryCode: "TZ" },
  { slug: "zanzibar-tz",                name: "Zanzibar",              countryCode: "TZ" },

  // ── Uganda ────────────────────────────────────────────────────────────────
  { slug: "central-region-ug",          name: "Central Region",        countryCode: "UG" },
  { slug: "eastern-region-ug",          name: "Eastern Region",        countryCode: "UG" },
  { slug: "northern-region-ug",         name: "Northern Region",       countryCode: "UG" },
  { slug: "western-region-ug",          name: "Western Region",        countryCode: "UG" },

  // ── Ethiopia ──────────────────────────────────────────────────────────────
  { slug: "addis-ababa-et",             name: "Addis Ababa",           countryCode: "ET" },
  { slug: "oromia-region-et",           name: "Oromia Region",         countryCode: "ET" },
  { slug: "amhara-region-et",           name: "Amhara Region",         countryCode: "ET" },
  { slug: "tigray-region-et",           name: "Tigray Region",         countryCode: "ET" },

  // ── Rwanda ────────────────────────────────────────────────────────────────
  { slug: "kigali-province-rw",         name: "Kigali Province",       countryCode: "RW" },
  { slug: "eastern-province-rw",        name: "Eastern Province",      countryCode: "RW" },
  { slug: "western-province-rw",        name: "Western Province",      countryCode: "RW" },

  // ── Zambia ────────────────────────────────────────────────────────────────
  { slug: "lusaka-province-zm",         name: "Lusaka Province",       countryCode: "ZM" },
  { slug: "copperbelt-province-zm",     name: "Copperbelt Province",   countryCode: "ZM" },
  { slug: "southern-province-zm",       name: "Southern Province",     countryCode: "ZM" },
  { slug: "eastern-province-zm",        name: "Eastern Province",      countryCode: "ZM" },

  // ── Mozambique ────────────────────────────────────────────────────────────
  { slug: "maputo-province-mz",         name: "Maputo Province",       countryCode: "MZ" },
  { slug: "nampula-province-mz",        name: "Nampula Province",      countryCode: "MZ" },
  { slug: "sofala-province-mz",         name: "Sofala Province",       countryCode: "MZ" },
  { slug: "zambezia-province-mz",       name: "Zambezia Province",     countryCode: "MZ" },

  // ── South Africa ──────────────────────────────────────────────────────────
  { slug: "gauteng-za",                 name: "Gauteng",               countryCode: "ZA" },
  { slug: "western-cape-za",            name: "Western Cape",          countryCode: "ZA" },
  { slug: "kwazulu-natal-za",           name: "KwaZulu-Natal",         countryCode: "ZA" },
  { slug: "eastern-cape-za",            name: "Eastern Cape",          countryCode: "ZA" },
  { slug: "limpopo-za",                 name: "Limpopo",               countryCode: "ZA" },

  // ── Botswana ──────────────────────────────────────────────────────────────
  { slug: "south-east-district-bw",     name: "South-East District",   countryCode: "BW" },
  { slug: "north-east-district-bw",     name: "North-East District",   countryCode: "BW" },
  { slug: "central-district-bw",        name: "Central District",      countryCode: "BW" },

  // ── Namibia ───────────────────────────────────────────────────────────────
  { slug: "khomas-region-na",           name: "Khomas Region",         countryCode: "NA" },
  { slug: "erongo-region-na",           name: "Erongo Region",         countryCode: "NA" },
  { slug: "oshana-region-na",           name: "Oshana Region",         countryCode: "NA" },

  // ── Angola ────────────────────────────────────────────────────────────────
  { slug: "luanda-province-ao",         name: "Luanda Province",       countryCode: "AO" },
  { slug: "huila-province-ao",          name: "Huila Province",        countryCode: "AO" },
  { slug: "benguela-province-ao",       name: "Benguela Province",     countryCode: "AO" },

  // ── Ghana ─────────────────────────────────────────────────────────────────
  { slug: "greater-accra-region-gh",    name: "Greater Accra Region",  countryCode: "GH" },
  { slug: "ashanti-region-gh",          name: "Ashanti Region",        countryCode: "GH" },
  { slug: "northern-region-gh",         name: "Northern Region",       countryCode: "GH" },

  // ── Nigeria ───────────────────────────────────────────────────────────────
  { slug: "lagos-state-ng",             name: "Lagos State",           countryCode: "NG" },
  { slug: "abuja-fct-ng",               name: "Abuja FCT",             countryCode: "NG" },
  { slug: "kano-state-ng",              name: "Kano State",            countryCode: "NG" },
  { slug: "rivers-state-ng",            name: "Rivers State",          countryCode: "NG" },

  // ── Senegal ───────────────────────────────────────────────────────────────
  { slug: "dakar-region-sn",            name: "Dakar Region",          countryCode: "SN" },
  { slug: "thies-region-sn",            name: "Thies Region",          countryCode: "SN" },

  // ── Cote d'Ivoire ─────────────────────────────────────────────────────────
  { slug: "abidjan-district-ci",        name: "Abidjan District",      countryCode: "CI" },
  { slug: "lagunes-district-ci",        name: "Lagunes District",      countryCode: "CI" },

  // ── Cameroon ──────────────────────────────────────────────────────────────
  { slug: "centre-region-cm",           name: "Centre Region",         countryCode: "CM" },
  { slug: "littoral-region-cm",         name: "Littoral Region",       countryCode: "CM" },

  // ── DR Congo ──────────────────────────────────────────────────────────────
  { slug: "kinshasa-province-cd",       name: "Kinshasa Province",     countryCode: "CD" },
  { slug: "haut-katanga-province-cd",   name: "Haut-Katanga Province", countryCode: "CD" },
  { slug: "nord-kivu-province-cd",      name: "Nord-Kivu Province",    countryCode: "CD" },

  // ── Egypt ─────────────────────────────────────────────────────────────────
  { slug: "cairo-governorate-eg",       name: "Cairo Governorate",     countryCode: "EG" },
  { slug: "alexandria-governorate-eg",  name: "Alexandria Governorate",countryCode: "EG" },
  { slug: "giza-governorate-eg",        name: "Giza Governorate",      countryCode: "EG" },

  // ── Morocco ───────────────────────────────────────────────────────────────
  { slug: "casablanca-settat-ma",       name: "Casablanca-Settat",     countryCode: "MA" },
  { slug: "rabat-sale-kenitra-ma",      name: "Rabat-Sale-Kenitra",    countryCode: "MA" },
  { slug: "marrakech-safi-ma",          name: "Marrakech-Safi",        countryCode: "MA" },

  // ── Tunisia ───────────────────────────────────────────────────────────────
  { slug: "tunis-governorate-tn",       name: "Tunis Governorate",     countryCode: "TN" },
  { slug: "sfax-governorate-tn",        name: "Sfax Governorate",      countryCode: "TN" },

  // ── Malawi ────────────────────────────────────────────────────────────────
  { slug: "central-region-mw",          name: "Central Region",        countryCode: "MW" },
  { slug: "southern-region-mw",         name: "Southern Region",       countryCode: "MW" },
  { slug: "northern-region-mw",         name: "Northern Region",       countryCode: "MW" },

  // ── Thailand ──────────────────────────────────────────────────────────────
  { slug: "bangkok-th",                 name: "Bangkok",               countryCode: "TH" },
  { slug: "chiang-mai-province-th",     name: "Chiang Mai Province",   countryCode: "TH" },
  { slug: "phuket-province-th",         name: "Phuket Province",       countryCode: "TH" },

  // ── Malaysia ──────────────────────────────────────────────────────────────
  { slug: "kuala-lumpur-my",            name: "Kuala Lumpur",          countryCode: "MY" },
  { slug: "selangor-my",                name: "Selangor",              countryCode: "MY" },
  { slug: "penang-my",                  name: "Penang",                countryCode: "MY" },

  // ── Indonesia ─────────────────────────────────────────────────────────────
  { slug: "dki-jakarta-id",             name: "DKI Jakarta",           countryCode: "ID" },
  { slug: "west-java-id",               name: "West Java",             countryCode: "ID" },
  { slug: "east-java-id",               name: "East Java",             countryCode: "ID" },
  { slug: "bali-id",                    name: "Bali",                  countryCode: "ID" },

  // ── Philippines ───────────────────────────────────────────────────────────
  { slug: "metro-manila-ph",            name: "Metro Manila",          countryCode: "PH" },
  { slug: "cebu-province-ph",           name: "Cebu Province",         countryCode: "PH" },
  { slug: "davao-del-sur-ph",           name: "Davao del Sur",         countryCode: "PH" },

  // ── Vietnam ───────────────────────────────────────────────────────────────
  { slug: "hanoi-vn",                   name: "Hanoi",                 countryCode: "VN" },
  { slug: "ho-chi-minh-city-vn",        name: "Ho Chi Minh City",      countryCode: "VN" },
  { slug: "da-nang-vn",                 name: "Da Nang",               countryCode: "VN" },
];
