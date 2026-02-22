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

export interface SeasonDoc {
  /** ISO 3166-1 alpha-2 country code */
  countryCode: string;
  /** English season name */
  name: string;
  /** Local language name */
  localName: string;
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
const ZW_SEASONS: SeasonDoc[] = [
  {
    countryCode: "ZW",
    name: "Main rains",
    localName: "Masika",
    months: [11, 12, 1, 2, 3],
    hemisphere: "south",
    description: "Flooding, road damage, planting",
  },
  {
    countryCode: "ZW",
    name: "Short rains",
    localName: "Munakamwe",
    months: [4],
    hemisphere: "south",
    description: "Harvest, late rains",
  },
  {
    countryCode: "ZW",
    name: "Cool dry",
    localName: "Chirimo",
    months: [5, 6, 7, 8],
    hemisphere: "south",
    description: "Frost, cold snaps, veld fires",
  },
  {
    countryCode: "ZW",
    name: "Hot dry",
    localName: "Zhizha",
    months: [9, 10],
    hemisphere: "south",
    description: "Heat stress, UV, water scarcity",
  },
];

// ── Southern Africa (similar to ZW) ──────────────────────────────────────
// Zambia, Mozambique, Malawi, Botswana, Namibia, Angola, eSwatini, Lesotho
const SOUTHERN_AFRICA_WET_DRY: SeasonTemplate[] = [
  { name: "Wet season", localName: "Rainy season", months: [11, 12, 1, 2, 3], hemisphere: "south", description: "Heavy rains, flooding, planting season" },
  { name: "Late rains", localName: "Late rains", months: [4], hemisphere: "south", description: "Harvest, scattered showers" },
  { name: "Cool dry season", localName: "Winter", months: [5, 6, 7, 8], hemisphere: "south", description: "Cool temperatures, frost risk in highlands" },
  { name: "Hot dry season", localName: "Pre-rains", months: [9, 10], hemisphere: "south", description: "Heat, dust, bushfire risk" },
];
const SOUTHERN_AFRICA_CODES = ["ZM", "MZ", "MW", "BW", "NA", "AO", "SZ", "LS"];

// ── South Africa (ZA) — Mediterranean-temperate mix ──────────────────────
const ZA_SEASONS: SeasonDoc[] = [
  { countryCode: "ZA", name: "Summer", localName: "Somer", months: [12, 1, 2], hemisphere: "south", description: "Hot, thunderstorms in the interior, beach season" },
  { countryCode: "ZA", name: "Autumn", localName: "Herfs", months: [3, 4, 5], hemisphere: "south", description: "Cooling, grape harvest, moderate rainfall" },
  { countryCode: "ZA", name: "Winter", localName: "Winter", months: [6, 7, 8], hemisphere: "south", description: "Cold, Cape rains, snow on peaks, frost inland" },
  { countryCode: "ZA", name: "Spring", localName: "Lente", months: [9, 10, 11], hemisphere: "south", description: "Warming, wildflower blooms, jacaranda season" },
];

// ── East Africa bimodal rains — Kenya, Tanzania, Uganda, Rwanda, Burundi ─
// Two distinct rainy seasons with dry periods between them
const EAST_AFRICA_BIMODAL: SeasonTemplate[] = [
  { name: "Long rains", localName: "Masika", months: [3, 4, 5], hemisphere: "equatorial", description: "Heavy rains, flooding, main planting season" },
  { name: "Warm dry", localName: "Kiangazi", months: [6, 7, 8, 9], hemisphere: "equatorial", description: "Dry, warm, safari high season" },
  { name: "Short rains", localName: "Vuli", months: [10, 11, 12], hemisphere: "equatorial", description: "Light rains, second planting, greening" },
  { name: "Hot dry", localName: "Jua kali", months: [1, 2], hemisphere: "equatorial", description: "Hot, dry, dust, beach season" },
];
const EAST_AFRICA_BIMODAL_CODES = ["KE", "TZ", "UG", "RW", "BI"];

// ── Ethiopia (ET) — unique calendar, Kiremt rains ────────────────────────
const ET_SEASONS: SeasonDoc[] = [
  { countryCode: "ET", name: "Main rains", localName: "Kiremt", months: [6, 7, 8, 9], hemisphere: "equatorial", description: "Heavy rains, highland flooding, main growing season" },
  { countryCode: "ET", name: "Dry season", localName: "Bega", months: [10, 11, 12, 1, 2], hemisphere: "equatorial", description: "Dry, cool highlands, harvest, travel season" },
  { countryCode: "ET", name: "Short rains", localName: "Belg", months: [3, 4, 5], hemisphere: "equatorial", description: "Light rains, secondary planting, warming" },
];

// ── Horn of Africa — Somalia, Djibouti, Eritrea ─────────────────────────
const HORN_BIMODAL: SeasonTemplate[] = [
  { name: "Main rains", localName: "Gu", months: [4, 5, 6], hemisphere: "equatorial", description: "Main rainy season, pastoral grazing, planting" },
  { name: "Dry season", localName: "Xagaa", months: [7, 8, 9], hemisphere: "equatorial", description: "Hot, dry, dust storms, water scarcity" },
  { name: "Short rains", localName: "Deyr", months: [10, 11], hemisphere: "equatorial", description: "Short rains, secondary planting" },
  { name: "Cool dry", localName: "Jilal", months: [12, 1, 2, 3], hemisphere: "equatorial", description: "Cool, dry, livestock migration" },
];
const HORN_CODES = ["SO", "DJ", "ER"];

// ── Sudan / South Sudan ─────────────────────────────────────────────────
const SUDAN_SEASONS: SeasonTemplate[] = [
  { name: "Dry season", localName: "Sayf", months: [11, 12, 1, 2, 3, 4], hemisphere: "north", description: "Hot, dry, Harmattan dust, water scarcity" },
  { name: "Rainy season", localName: "Kharif", months: [5, 6, 7, 8, 9, 10], hemisphere: "north", description: "Monsoon rains, Nile flooding, farming" },
];
const SUDAN_CODES = ["SD", "SS"];

// ── West Africa Sahel — Mali, Niger, Burkina Faso, Mauritania, Chad ─────
// Single wet season driven by the ITCZ
const SAHEL_SEASONS: SeasonTemplate[] = [
  { name: "Dry season", localName: "Saison sèche", months: [10, 11, 12, 1, 2, 3, 4, 5], hemisphere: "north", description: "Hot, dry, Harmattan dust, water stress" },
  { name: "Rainy season", localName: "Hivernage", months: [6, 7, 8, 9], hemisphere: "north", description: "Monsoon rains, flooding, main planting season" },
];
const SAHEL_CODES = ["ML", "NE", "BF", "MR", "TD"];

// ── West Africa coastal — Nigeria, Ghana, Senegal, Côte d'Ivoire, etc. ─
// Bimodal rains near the coast, single season inland
const WEST_AFRICA_COASTAL: SeasonTemplate[] = [
  { name: "Long rains", localName: "Grande saison des pluies", months: [4, 5, 6, 7], hemisphere: "north", description: "Heavy rains, flooding, main farming season" },
  { name: "Short dry", localName: "Petite saison sèche", months: [8], hemisphere: "north", description: "Brief dry spell, mid-season break" },
  { name: "Short rains", localName: "Petite saison des pluies", months: [9, 10, 11], hemisphere: "north", description: "Second rains, late planting" },
  { name: "Dry season", localName: "Harmattan", months: [12, 1, 2, 3], hemisphere: "north", description: "Dry, dusty Harmattan winds, cool mornings" },
];
const WEST_AFRICA_COASTAL_CODES = ["NG", "GH", "SN", "CI", "BJ", "TG", "LR", "SL", "GN", "GW", "GM"];

// ── Central Africa — Cameroon, DRC, Congo, Gabon, CAR, Eq. Guinea, STP ─
// Equatorial double-maxima rainfall
const CENTRAL_AFRICA: SeasonTemplate[] = [
  { name: "Long rains", localName: "Grande saison des pluies", months: [3, 4, 5], hemisphere: "equatorial", description: "Heavy rains, forest flooding, planting" },
  { name: "Short dry", localName: "Petite saison sèche", months: [6, 7], hemisphere: "equatorial", description: "Brief dry spell, harvest" },
  { name: "Short rains", localName: "Petite saison des pluies", months: [8, 9, 10, 11], hemisphere: "equatorial", description: "Second rains, second planting" },
  { name: "Dry season", localName: "Grande saison sèche", months: [12, 1, 2], hemisphere: "equatorial", description: "Dry, cooler, travel season" },
];
const CENTRAL_AFRICA_CODES = ["CM", "CD", "CG", "GA", "CF", "GQ", "ST"];

// ── North Africa Mediterranean — Morocco, Algeria, Tunisia, Libya, Egypt ─
const NORTH_AFRICA: SeasonTemplate[] = [
  { name: "Spring", localName: "الربيع", months: [3, 4, 5], hemisphere: "north", description: "Warming, wildflowers, olive blooms" },
  { name: "Summer", localName: "الصيف", months: [6, 7, 8], hemisphere: "north", description: "Hot, dry, peak tourism, heat advisories" },
  { name: "Autumn", localName: "الخريف", months: [9, 10, 11], hemisphere: "north", description: "Cooling, olive harvest, first rains" },
  { name: "Winter", localName: "الشتاء", months: [12, 1, 2], hemisphere: "north", description: "Cool, Mediterranean rains, Atlas snow" },
];
const NORTH_AFRICA_CODES = ["MA", "DZ", "TN", "LY", "EG"];

// ── Cape Verde (CV) — Atlantic island, distinct pattern ──────────────────
const CV_SEASONS: SeasonDoc[] = [
  { countryCode: "CV", name: "Dry season", localName: "Tempo das Brisas", months: [11, 12, 1, 2, 3, 4, 5, 6], hemisphere: "north", description: "Dry, trade winds, mild temperatures" },
  { countryCode: "CV", name: "Rainy season", localName: "Tempo das Águas", months: [7, 8, 9, 10], hemisphere: "north", description: "Brief tropical rains, humid, hurricane season" },
];

// ── Indian Ocean Islands — Madagascar, Mauritius, Comoros, Seychelles, Réunion, Mayotte ─
const INDIAN_OCEAN: SeasonTemplate[] = [
  { name: "Wet season", localName: "Saison chaude", months: [11, 12, 1, 2, 3, 4], hemisphere: "south", description: "Hot, humid, cyclone risk, heavy rains" },
  { name: "Dry season", localName: "Saison sèche", months: [5, 6, 7, 8, 9, 10], hemisphere: "south", description: "Cool, dry, trade winds, pleasant" },
];
const INDIAN_OCEAN_CODES = ["MG", "MU", "KM", "SC", "RE", "YT"];

// ── ASEAN Tropical Monsoon — Thailand, Myanmar, Cambodia, Laos, Vietnam ─
const ASEAN_MONSOON: SeasonTemplate[] = [
  { name: "Hot season", localName: "Røduu ráawn", months: [3, 4, 5], hemisphere: "north", description: "Extreme heat, Songkran, pre-monsoon thunderstorms" },
  { name: "Rainy season", localName: "Røduu fǒn", months: [6, 7, 8, 9, 10], hemisphere: "north", description: "Southwest monsoon, heavy rains, flooding" },
  { name: "Cool season", localName: "Røduu nǎaw", months: [11, 12, 1, 2], hemisphere: "north", description: "Cool, dry, peak tourism, harvest" },
];
const ASEAN_MONSOON_CODES = ["TH", "MM", "KH", "LA", "VN"];

// ── Malaysia, Singapore, Brunei — equatorial, year-round rain ────────────
const ASEAN_EQUATORIAL: SeasonTemplate[] = [
  { name: "Northeast monsoon", localName: "Monsun Timur Laut", months: [11, 12, 1, 2, 3], hemisphere: "equatorial", description: "Heavy rains on east coast, flooding" },
  { name: "Inter-monsoon", localName: "Peralihan", months: [4, 5], hemisphere: "equatorial", description: "Thunderstorms, variable weather" },
  { name: "Southwest monsoon", localName: "Monsun Barat Daya", months: [6, 7, 8, 9], hemisphere: "equatorial", description: "Drier on east, rain on west, haze season" },
  { name: "Inter-monsoon", localName: "Peralihan", months: [10], hemisphere: "equatorial", description: "Thunderstorms, transition, variable" },
];
const ASEAN_EQUATORIAL_CODES = ["MY", "SG", "BN"];

// ── Indonesia — equatorial archipelago ───────────────────────────────────
const ID_SEASONS: SeasonDoc[] = [
  { countryCode: "ID", name: "Wet season", localName: "Musim Hujan", months: [10, 11, 12, 1, 2, 3], hemisphere: "equatorial", description: "Heavy rains, flooding, planting, high humidity" },
  { countryCode: "ID", name: "Dry season", localName: "Musim Kemarau", months: [4, 5, 6, 7, 8, 9], hemisphere: "equatorial", description: "Dry, cooler, harvest, peak tourism" },
];

// ── Philippines — typhoon belt ───────────────────────────────────────────
const PH_SEASONS: SeasonDoc[] = [
  { countryCode: "PH", name: "Hot dry season", localName: "Tag-init", months: [3, 4, 5], hemisphere: "north", description: "Extreme heat, drought risk, water rationing" },
  { countryCode: "PH", name: "Wet season", localName: "Tag-ulan", months: [6, 7, 8, 9, 10, 11], hemisphere: "north", description: "Southwest monsoon, typhoons, heavy flooding" },
  { countryCode: "PH", name: "Cool dry season", localName: "Tag-lamig", months: [12, 1, 2], hemisphere: "north", description: "Northeast monsoon, cooler, drier, Amihan winds" },
];

// ── Timor-Leste (TL) — tropical monsoon ─────────────────────────────────
const TL_SEASONS: SeasonDoc[] = [
  { countryCode: "TL", name: "Wet season", localName: "Tempu udan", months: [11, 12, 1, 2, 3, 4, 5], hemisphere: "south", description: "Heavy monsoon rains, flooding, planting" },
  { countryCode: "TL", name: "Dry season", localName: "Tempu bailoron", months: [6, 7, 8, 9, 10], hemisphere: "south", description: "Dry, cool, harvest, dust" },
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
