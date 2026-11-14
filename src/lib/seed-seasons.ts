/**
 * Seed data for the `seasons` MongoDB collection.
 *
 * Read only by `POST /api/db-init` (one-time bootstrap) and tests.
 * At runtime, callers use getSeasonForDate() from db.ts which queries MongoDB
 * and falls back to the synchronous ZW logic for unknown countries.
 *
 * Season data is grouped by climate zone — countries sharing similar seasonal
 * patterns use a shared definition expanded at export time. Each country gets
 * its own SeasonDoc entries with localised names where available.
 *
 * Sources: national meteorological services, WMO climate normals, FAO crop calendars.
 */

/**
 * One name for a season, in one language, optionally only for some regions.
 * Season names change by region, not by country: Zimbabwe's summer rains are
 * Zhizha in Shona-speaking provinces and Ihlobo in Ndebele-speaking ones.
 */
export interface SeasonName {
  /** BCP 47 language tag ("en", "sn", "nd", "af"). */
  lang: string;
  name: string;
  /**
   * Admin-1 P-codes (OCHA COD-AB, as in `agriculture.adminAreas`) this name
   * is used in. Absent: the name is for the whole country.
   */
  regions?: string[];
}

export interface SeasonDoc {
  /** ISO 3166-1 alpha-2 country code */
  countryCode: string;
  /** English season name */
  name: string;
  /**
   * DEPRECATED, kept while readers move to `names` (the Rust Workers still
   * read it). A single name locked a country to one language, so on a row
   * that has `names` this is the English name. Rows not yet converted still
   * carry their old single local name here.
   */
  localName: string;
  /**
   * The season's names by language and region. Resolve with
   * `resolveSeasonName` (season-names.ts): the user's region first, then
   * their language, then English. Absent on rows not yet converted.
   */
  names?: SeasonName[];
  /** 1-based months that belong to this season (e.g. [11, 12, 1, 2, 3]) */
  months: number[];
  hemisphere: "north" | "south" | "equatorial";
  /** Human-readable description for AI context */
  description: string;
}

// ── Helper to expand a shared pattern to multiple country codes ────────────
interface SeasonTemplate {
  name: string;
  localName: string;
  names?: SeasonName[];
  months: number[];
  hemisphere: "north" | "south" | "equatorial";
  description: string;
}

function expand(codes: string[], templates: SeasonTemplate[]): SeasonDoc[] {
  return codes.flatMap((code) =>
    templates.map((t) => ({ countryCode: code, ...t })),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SEASON DEFINITIONS BY CLIMATE ZONE
// ═══════════════════════════════════════════════════════════════════════════

// ── Zimbabwe (ZW) ─────────────────────────────────────────────────────────
// Shona is spoken in the five Mashonaland/Manicaland/Masvingo/Midlands
// provinces and Harare, Ndebele in Matabeleland North and South and Bulawayo.
// The codes are the province P-codes of OCHA COD-AB (HDX cod-ab-zwe, as held
// in `agriculture.adminAreas`); the names and the month edges still need
// confirming by a native Shona and a native Ndebele speaker.
const ZW_SHONA_REGIONS = [
  "ZW11", // Manicaland
  "ZW12", // Mashonaland Central
  "ZW13", // Mashonaland East
  "ZW14", // Mashonaland West
  "ZW17", // Midlands
  "ZW18", // Masvingo
  "ZW19", // Harare
];
const ZW_NDEBELE_REGIONS = [
  "ZW10", // Bulawayo
  "ZW15", // Matabeleland North
  "ZW16", // Matabeleland South
];
const zwNames = (
  name: string,
  shona: string,
  ndebele: string,
): SeasonName[] => [
  { lang: "en", name },
  { lang: "sn", name: shona, regions: ZW_SHONA_REGIONS },
  { lang: "nd", name: ndebele, regions: ZW_NDEBELE_REGIONS },
];
const ZW_SEASONS: SeasonDoc[] = [
  {
    countryCode: "ZW",
    name: "Summer rains",
    localName: "Summer rains",
    names: zwNames("Summer rains", "Zhizha", "Ihlobo"),
    months: [11, 12, 1, 2, 3],
    hemisphere: "south",
    description: "Flooding, road damage, planting",
  },
  {
    countryCode: "ZW",
    name: "Late rains and harvest",
    localName: "Late rains and harvest",
    names: zwNames("Late rains and harvest", "Matsutso", "Ikwindla"),
    months: [4],
    hemisphere: "south",
    description: "Harvest, late rains",
  },
  {
    countryCode: "ZW",
    name: "Cool dry",
    localName: "Cool dry",
    names: zwNames("Cool dry", "Chando", "Ubusika"),
    months: [5, 6, 7, 8],
    hemisphere: "south",
    description: "Frost, cold snaps, veld fires",
  },
  {
    countryCode: "ZW",
    name: "Hot dry",
    localName: "Hot dry",
    names: zwNames("Hot dry", "Chirimo", "Intwasahlobo"),
    months: [9, 10],
    hemisphere: "south",
    description: "Heat stress, UV, water scarcity",
  },
];

// ── Southern Africa (similar to ZW) ──────────────────────────────────────
// Zambia, Mozambique, Malawi, Botswana, Namibia, Angola, eSwatini, Lesotho
// English only until a speaker of each language sources the local names.
const SOUTHERN_AFRICA_WET_DRY: SeasonTemplate[] = [
  {
    name: "Wet season",
    localName: "Wet season",
    names: [{ lang: "en", name: "Wet season" }],
    months: [11, 12, 1, 2, 3],
    hemisphere: "south",
    description: "Heavy rains, flooding, planting season",
  },
  {
    name: "Late rains",
    localName: "Late rains",
    names: [{ lang: "en", name: "Late rains" }],
    months: [4],
    hemisphere: "south",
    description: "Harvest, scattered showers",
  },
  {
    name: "Cool dry season",
    localName: "Cool dry season",
    names: [{ lang: "en", name: "Cool dry season" }],
    months: [5, 6, 7, 8],
    hemisphere: "south",
    description: "Cool temperatures, frost risk in highlands",
  },
  {
    name: "Hot dry season",
    localName: "Hot dry season",
    names: [{ lang: "en", name: "Hot dry season" }],
    months: [9, 10],
    hemisphere: "south",
    description: "Heat, dust, bushfire risk",
  },
];
const SOUTHERN_AFRICA_CODES = ["ZM", "MZ", "MW", "BW", "NA", "AO", "SZ", "LS"];

// ── South Africa (ZA) — Mediterranean-temperate mix ──────────────────────
const ZA_SEASONS: SeasonDoc[] = [
  {
    countryCode: "ZA",
    name: "Summer",
    localName: "Summer",
    names: [
      { lang: "en", name: "Summer" },
      { lang: "af", name: "Somer" },
    ],
    months: [12, 1, 2],
    hemisphere: "south",
    description: "Hot, thunderstorms in the interior, beach season",
  },
  {
    countryCode: "ZA",
    name: "Autumn",
    localName: "Autumn",
    names: [
      { lang: "en", name: "Autumn" },
      { lang: "af", name: "Herfs" },
    ],
    months: [3, 4, 5],
    hemisphere: "south",
    description: "Cooling, grape harvest, moderate rainfall",
  },
  {
    countryCode: "ZA",
    name: "Winter",
    localName: "Winter",
    names: [
      { lang: "en", name: "Winter" },
      { lang: "af", name: "Winter" },
    ],
    months: [6, 7, 8],
    hemisphere: "south",
    description: "Cold, Cape rains, snow on peaks, frost inland",
  },
  {
    countryCode: "ZA",
    name: "Spring",
    localName: "Spring",
    names: [
      { lang: "en", name: "Spring" },
      { lang: "af", name: "Lente" },
    ],
    months: [9, 10, 11],
    hemisphere: "south",
    description: "Warming, wildflower blooms, jacaranda season",
  },
];

// ── East Africa bimodal rains — Kenya, Tanzania, Uganda, Rwanda, Burundi ─
// Two distinct rainy seasons with dry periods between them
const EAST_AFRICA_BIMODAL: SeasonTemplate[] = [
  {
    name: "Long rains",
    localName: "Masika",
    months: [3, 4, 5],
    hemisphere: "equatorial",
    description: "Heavy rains, flooding, main planting season",
  },
  {
    name: "Warm dry",
    localName: "Kiangazi",
    months: [6, 7, 8, 9],
    hemisphere: "equatorial",
    description: "Dry, warm, safari high season",
  },
  {
    name: "Short rains",
    localName: "Vuli",
    months: [10, 11, 12],
    hemisphere: "equatorial",
    description: "Light rains, second planting, greening",
  },
  {
    name: "Hot dry",
    localName: "Jua kali",
    months: [1, 2],
    hemisphere: "equatorial",
    description: "Hot, dry, dust, beach season",
  },
];
const EAST_AFRICA_BIMODAL_CODES = ["KE", "TZ", "UG", "RW", "BI"];

// ── Ethiopia (ET) — unique calendar, Kiremt rains ────────────────────────
const ET_SEASONS: SeasonDoc[] = [
  {
    countryCode: "ET",
    name: "Main rains",
    localName: "Kiremt",
    months: [6, 7, 8, 9],
    hemisphere: "equatorial",
    description: "Heavy rains, highland flooding, main growing season",
  },
  {
    countryCode: "ET",
    name: "Dry season",
    localName: "Bega",
    months: [10, 11, 12, 1, 2],
    hemisphere: "equatorial",
    description: "Dry, cool highlands, harvest, travel season",
  },
  {
    countryCode: "ET",
    name: "Short rains",
    localName: "Belg",
    months: [3, 4, 5],
    hemisphere: "equatorial",
    description: "Light rains, secondary planting, warming",
  },
];

// ── Horn of Africa — Somalia, Djibouti, Eritrea ─────────────────────────
const HORN_BIMODAL: SeasonTemplate[] = [
  {
    name: "Main rains",
    localName: "Gu",
    months: [4, 5, 6],
    hemisphere: "equatorial",
    description: "Main rainy season, pastoral grazing, planting",
  },
  {
    name: "Dry season",
    localName: "Xagaa",
    months: [7, 8, 9],
    hemisphere: "equatorial",
    description: "Hot, dry, dust storms, water scarcity",
  },
  {
    name: "Short rains",
    localName: "Deyr",
    months: [10, 11],
    hemisphere: "equatorial",
    description: "Short rains, secondary planting",
  },
  {
    name: "Cool dry",
    localName: "Jilal",
    months: [12, 1, 2, 3],
    hemisphere: "equatorial",
    description: "Cool, dry, livestock migration",
  },
];
const HORN_CODES = ["SO", "DJ", "ER"];

// ── Sudan / South Sudan ─────────────────────────────────────────────────
const SUDAN_SEASONS: SeasonTemplate[] = [
  {
    name: "Dry season",
    localName: "Sayf",
    months: [11, 12, 1, 2, 3, 4],
    hemisphere: "north",
    description: "Hot, dry, Harmattan dust, water scarcity",
  },
  {
    name: "Rainy season",
    localName: "Kharif",
    months: [5, 6, 7, 8, 9, 10],
    hemisphere: "north",
    description: "Monsoon rains, Nile flooding, farming",
  },
];
const SUDAN_CODES = ["SD", "SS"];

// ── West Africa Sahel — Mali, Niger, Burkina Faso, Mauritania, Chad ─────
// Single wet season driven by the ITCZ
const SAHEL_SEASONS: SeasonTemplate[] = [
  {
    name: "Dry season",
    localName: "Saison sèche",
    months: [10, 11, 12, 1, 2, 3, 4, 5],
    hemisphere: "north",
    description: "Hot, dry, Harmattan dust, water stress",
  },
  {
    name: "Rainy season",
    localName: "Hivernage",
    months: [6, 7, 8, 9],
    hemisphere: "north",
    description: "Monsoon rains, flooding, main planting season",
  },
];
const SAHEL_CODES = ["ML", "NE", "BF", "MR", "TD"];

// ── West Africa, English names — Nigeria, Ghana, Liberia, Sierra Leone, ──
// ── The Gambia, Guinea-Bissau ─────────────────────────────────────────────
// Bimodal rains near the coast, single season inland.
// English names only. These countries carried the French names of the
// francophone coast ("Grande saison des pluies"), which none of them speaks
// (Guinea-Bissau's official language is Portuguese). Local-language names are
// added only from a sourced speaker.
const WEST_AFRICA_ENGLISH: SeasonTemplate[] = [
  {
    name: "Long rains",
    localName: "Long rains",
    names: [{ lang: "en", name: "Long rains" }],
    months: [4, 5, 6, 7],
    hemisphere: "north",
    description: "Heavy rains, flooding, main farming season",
  },
  {
    name: "Short dry",
    localName: "Short dry",
    names: [{ lang: "en", name: "Short dry" }],
    months: [8],
    hemisphere: "north",
    description: "Brief dry spell, mid-season break",
  },
  {
    name: "Short rains",
    localName: "Short rains",
    names: [{ lang: "en", name: "Short rains" }],
    months: [9, 10, 11],
    hemisphere: "north",
    description: "Second rains, late planting",
  },
  {
    name: "Dry season",
    localName: "Dry season",
    names: [{ lang: "en", name: "Dry season" }],
    months: [12, 1, 2, 3],
    hemisphere: "north",
    description: "Dry, dusty Harmattan winds, cool mornings",
  },
];
const WEST_AFRICA_ENGLISH_CODES = ["NG", "GH", "LR", "SL", "GM", "GW"];

// ── West Africa coastal, francophone — Senegal, Côte d'Ivoire, Benin, ────
// ── Togo, Guinea ──────────────────────────────────────────────────────────
// Same months, French names.
const WEST_AFRICA_COASTAL: SeasonTemplate[] = [
  {
    name: "Long rains",
    localName: "Grande saison des pluies",
    months: [4, 5, 6, 7],
    hemisphere: "north",
    description: "Heavy rains, flooding, main farming season",
  },
  {
    name: "Short dry",
    localName: "Petite saison sèche",
    months: [8],
    hemisphere: "north",
    description: "Brief dry spell, mid-season break",
  },
  {
    name: "Short rains",
    localName: "Petite saison des pluies",
    months: [9, 10, 11],
    hemisphere: "north",
    description: "Second rains, late planting",
  },
  {
    name: "Dry season",
    localName: "Harmattan",
    months: [12, 1, 2, 3],
    hemisphere: "north",
    description: "Dry, dusty Harmattan winds, cool mornings",
  },
];
const WEST_AFRICA_COASTAL_CODES = ["SN", "CI", "BJ", "TG", "GN"];

// ── Central Africa — Cameroon, DRC, Congo, Gabon, CAR, Eq. Guinea, STP ─
// Equatorial double-maxima rainfall
const CENTRAL_AFRICA: SeasonTemplate[] = [
  {
    name: "Long rains",
    localName: "Grande saison des pluies",
    months: [3, 4, 5],
    hemisphere: "equatorial",
    description: "Heavy rains, forest flooding, planting",
  },
  {
    name: "Short dry",
    localName: "Petite saison sèche",
    months: [6, 7],
    hemisphere: "equatorial",
    description: "Brief dry spell, harvest",
  },
  {
    name: "Short rains",
    localName: "Petite saison des pluies",
    months: [8, 9, 10, 11],
    hemisphere: "equatorial",
    description: "Second rains, second planting",
  },
  {
    name: "Dry season",
    localName: "Grande saison sèche",
    months: [12, 1, 2],
    hemisphere: "equatorial",
    description: "Dry, cooler, travel season",
  },
];
const CENTRAL_AFRICA_CODES = ["CM", "CD", "CG", "GA", "CF", "GQ", "ST"];

// ── North Africa Mediterranean — Morocco, Algeria, Tunisia, Libya, Egypt ─
const NORTH_AFRICA: SeasonTemplate[] = [
  {
    name: "Spring",
    localName: "الربيع",
    months: [3, 4, 5],
    hemisphere: "north",
    description: "Warming, wildflowers, olive blooms",
  },
  {
    name: "Summer",
    localName: "الصيف",
    months: [6, 7, 8],
    hemisphere: "north",
    description: "Hot, dry, peak tourism, heat advisories",
  },
  {
    name: "Autumn",
    localName: "الخريف",
    months: [9, 10, 11],
    hemisphere: "north",
    description: "Cooling, olive harvest, first rains",
  },
  {
    name: "Winter",
    localName: "الشتاء",
    months: [12, 1, 2],
    hemisphere: "north",
    description: "Cool, Mediterranean rains, Atlas snow",
  },
];
const NORTH_AFRICA_CODES = ["MA", "DZ", "TN", "LY", "EG"];

// ── Cape Verde (CV) — Atlantic island, distinct pattern ──────────────────
const CV_SEASONS: SeasonDoc[] = [
  {
    countryCode: "CV",
    name: "Dry season",
    localName: "Tempo das Brisas",
    months: [11, 12, 1, 2, 3, 4, 5, 6],
    hemisphere: "north",
    description: "Dry, trade winds, mild temperatures",
  },
  {
    countryCode: "CV",
    name: "Rainy season",
    localName: "Tempo das Águas",
    months: [7, 8, 9, 10],
    hemisphere: "north",
    description: "Brief tropical rains, humid, hurricane season",
  },
];

// ── Indian Ocean Islands — Madagascar, Mauritius, Comoros, Seychelles, Réunion, Mayotte ─
const INDIAN_OCEAN: SeasonTemplate[] = [
  {
    name: "Wet season",
    localName: "Saison chaude",
    months: [11, 12, 1, 2, 3, 4],
    hemisphere: "south",
    description: "Hot, humid, cyclone risk, heavy rains",
  },
  {
    name: "Dry season",
    localName: "Saison sèche",
    months: [5, 6, 7, 8, 9, 10],
    hemisphere: "south",
    description: "Cool, dry, trade winds, pleasant",
  },
];
const INDIAN_OCEAN_CODES = ["MG", "MU", "KM", "SC", "RE", "YT"];

// ── ASEAN Tropical Monsoon — Thailand, Myanmar, Cambodia, Laos, Vietnam ─
const ASEAN_MONSOON: SeasonTemplate[] = [
  {
    name: "Hot season",
    localName: "Røduu ráawn",
    months: [3, 4, 5],
    hemisphere: "north",
    description: "Extreme heat, Songkran, pre-monsoon thunderstorms",
  },
  {
    name: "Rainy season",
    localName: "Røduu fǒn",
    months: [6, 7, 8, 9, 10],
    hemisphere: "north",
    description: "Southwest monsoon, heavy rains, flooding",
  },
  {
    name: "Cool season",
    localName: "Røduu nǎaw",
    months: [11, 12, 1, 2],
    hemisphere: "north",
    description: "Cool, dry, peak tourism, harvest",
  },
];
const ASEAN_MONSOON_CODES = ["TH", "MM", "KH", "LA", "VN"];

// ── Malaysia, Singapore, Brunei — equatorial, year-round rain ────────────
const ASEAN_EQUATORIAL: SeasonTemplate[] = [
  {
    name: "Northeast monsoon",
    localName: "Monsun Timur Laut",
    months: [11, 12, 1, 2, 3],
    hemisphere: "equatorial",
    description: "Heavy rains on east coast, flooding",
  },
  {
    name: "Inter-monsoon",
    localName: "Peralihan",
    months: [4, 5],
    hemisphere: "equatorial",
    description: "Thunderstorms, variable weather",
  },
  {
    name: "Southwest monsoon",
    localName: "Monsun Barat Daya",
    months: [6, 7, 8, 9],
    hemisphere: "equatorial",
    description: "Drier on east, rain on west, haze season",
  },
  {
    name: "Inter-monsoon",
    localName: "Peralihan",
    months: [10],
    hemisphere: "equatorial",
    description: "Thunderstorms, transition, variable",
  },
];
const ASEAN_EQUATORIAL_CODES = ["MY", "SG", "BN"];

// ── Indonesia — equatorial archipelago ───────────────────────────────────
const ID_SEASONS: SeasonDoc[] = [
  {
    countryCode: "ID",
    name: "Wet season",
    localName: "Musim Hujan",
    months: [10, 11, 12, 1, 2, 3],
    hemisphere: "equatorial",
    description: "Heavy rains, flooding, planting, high humidity",
  },
  {
    countryCode: "ID",
    name: "Dry season",
    localName: "Musim Kemarau",
    months: [4, 5, 6, 7, 8, 9],
    hemisphere: "equatorial",
    description: "Dry, cooler, harvest, peak tourism",
  },
];

// ── Philippines — typhoon belt ───────────────────────────────────────────
const PH_SEASONS: SeasonDoc[] = [
  {
    countryCode: "PH",
    name: "Hot dry season",
    localName: "Tag-init",
    months: [3, 4, 5],
    hemisphere: "north",
    description: "Extreme heat, drought risk, water rationing",
  },
  {
    countryCode: "PH",
    name: "Wet season",
    localName: "Tag-ulan",
    months: [6, 7, 8, 9, 10, 11],
    hemisphere: "north",
    description: "Southwest monsoon, typhoons, heavy flooding",
  },
  {
    countryCode: "PH",
    name: "Cool dry season",
    localName: "Tag-lamig",
    months: [12, 1, 2],
    hemisphere: "north",
    description: "Northeast monsoon, cooler, drier, Amihan winds",
  },
];

// ── Timor-Leste (TL) — tropical monsoon ─────────────────────────────────
const TL_SEASONS: SeasonDoc[] = [
  {
    countryCode: "TL",
    name: "Wet season",
    localName: "Tempu udan",
    months: [11, 12, 1, 2, 3, 4, 5],
    hemisphere: "south",
    description: "Heavy monsoon rains, flooding, planting",
  },
  {
    countryCode: "TL",
    name: "Dry season",
    localName: "Tempu bailoron",
    months: [6, 7, 8, 9, 10],
    hemisphere: "south",
    description: "Dry, cool, harvest, dust",
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT: All season definitions
// ═══════════════════════════════════════════════════════════════════════════
export const SEASONS: SeasonDoc[] = [
  // Southern Africa
  ...ZW_SEASONS,
  ...ZA_SEASONS,
  ...expand(SOUTHERN_AFRICA_CODES, SOUTHERN_AFRICA_WET_DRY),

  // East Africa
  ...expand(EAST_AFRICA_BIMODAL_CODES, EAST_AFRICA_BIMODAL),
  ...ET_SEASONS,
  ...expand(HORN_CODES, HORN_BIMODAL),
  ...expand(SUDAN_CODES, SUDAN_SEASONS),

  // West Africa
  ...expand(SAHEL_CODES, SAHEL_SEASONS),
  ...expand(WEST_AFRICA_ENGLISH_CODES, WEST_AFRICA_ENGLISH),
  ...expand(WEST_AFRICA_COASTAL_CODES, WEST_AFRICA_COASTAL),
  ...CV_SEASONS,

  // Central Africa
  ...expand(CENTRAL_AFRICA_CODES, CENTRAL_AFRICA),

  // North Africa
  ...expand(NORTH_AFRICA_CODES, NORTH_AFRICA),

  // Indian Ocean
  ...expand(INDIAN_OCEAN_CODES, INDIAN_OCEAN),

  // ASEAN
  ...expand(ASEAN_MONSOON_CODES, ASEAN_MONSOON),
  ...expand(ASEAN_EQUATORIAL_CODES, ASEAN_EQUATORIAL),
  ...ID_SEASONS,
  ...PH_SEASONS,
  ...TL_SEASONS,
];
