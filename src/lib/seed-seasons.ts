/**
 * Seed data for the `seasons` MongoDB collection.
 *
 * Read only by `POST /api/db-init` (one-time bootstrap) and tests.
 * At runtime, callers use getSeasonForDate() from db.ts which queries MongoDB
 * and falls back to the synchronous ZW logic for unknown countries.
 *
 * Encodes the logic previously hardcoded in getZimbabweSeason().
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
  hemisphere: "north" | "south";
  /** Human-readable description for AI context */
  description: string;
}

export const SEASONS: SeasonDoc[] = [
  // ── Zimbabwe (ZW) ─────────────────────────────────────────────────────────
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
