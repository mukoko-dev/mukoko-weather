/**
 * Global location seed data for mukoko weather (outside Zimbabwe).
 * Covers capital cities + major urban centres across all 54 AU member states
 * and ASEAN countries including Singapore.
 * Each entry follows the WeatherLocation pattern with country field set.
 */

import type { WeatherLocation } from "./locations";

export const GLOBAL_LOCATIONS: WeatherLocation[] = [
  // ── Kenya (KE) ────────────────────────────────────────────────────────────
  { slug: "nairobi-ke", name: "Nairobi", province: "Nairobi County", lat: -1.29, lon: 36.82, elevation: 1795, tags: ["city", "travel"], country: "KE", source: "seed", provinceSlug: "nairobi-county-ke" },
  { slug: "mombasa-ke", name: "Mombasa", province: "Mombasa County", lat: -4.05, lon: 39.67, elevation: 17, tags: ["city", "tourism", "travel"], country: "KE", source: "seed", provinceSlug: "mombasa-county-ke" },
  { slug: "kisumu-ke", name: "Kisumu", province: "Kisumu County", lat: -0.10, lon: 34.75, elevation: 1131, tags: ["city"], country: "KE", source: "seed", provinceSlug: "kisumu-county-ke" },
  { slug: "nakuru-ke", name: "Nakuru", province: "Nakuru County", lat: -0.28, lon: 36.07, elevation: 1850, tags: ["city", "farming"], country: "KE", source: "seed", provinceSlug: "nakuru-county-ke" },
  { slug: "eldoret-ke", name: "Eldoret", province: "Uasin Gishu County", lat: 0.52, lon: 35.27, elevation: 2100, tags: ["city", "farming"], country: "KE", source: "seed", provinceSlug: "uasin-gishu-county-ke" },

  // ── Tanzania (TZ) ─────────────────────────────────────────────────────────
  { slug: "dar-es-salaam-tz", name: "Dar es Salaam", province: "Dar es Salaam Region", lat: -6.79, lon: 39.21, elevation: 55, tags: ["city", "travel"], country: "TZ", source: "seed", provinceSlug: "dar-es-salaam-region-tz" },
  { slug: "dodoma-tz", name: "Dodoma", province: "Dodoma Region", lat: -6.17, lon: 35.74, elevation: 1120, tags: ["city"], country: "TZ", source: "seed", provinceSlug: "dodoma-region-tz" },
  { slug: "mwanza-tz", name: "Mwanza", province: "Mwanza Region", lat: -2.52, lon: 32.90, elevation: 1140, tags: ["city"], country: "TZ", source: "seed", provinceSlug: "mwanza-region-tz" },
  { slug: "arusha-tz", name: "Arusha", province: "Arusha Region", lat: -3.37, lon: 36.68, elevation: 1387, tags: ["city", "tourism"], country: "TZ", source: "seed", provinceSlug: "arusha-region-tz" },
  { slug: "zanzibar-tz", name: "Zanzibar City", province: "Zanzibar", lat: -6.16, lon: 39.19, elevation: 10, tags: ["city", "tourism"], country: "TZ", source: "seed", provinceSlug: "zanzibar-tz" },

  // ── Uganda (UG) ───────────────────────────────────────────────────────────
  { slug: "kampala-ug", name: "Kampala", province: "Central Region", lat: 0.32, lon: 32.58, elevation: 1189, tags: ["city", "travel"], country: "UG", source: "seed", provinceSlug: "central-region-ug" },
  { slug: "entebbe-ug", name: "Entebbe", province: "Central Region", lat: 0.05, lon: 32.46, elevation: 1155, tags: ["city", "travel"], country: "UG", source: "seed", provinceSlug: "central-region-ug" },
  { slug: "gulu-ug", name: "Gulu", province: "Northern Region", lat: 2.77, lon: 32.31, elevation: 1047, tags: ["city"], country: "UG", source: "seed", provinceSlug: "northern-region-ug" },
  { slug: "jinja-ug", name: "Jinja", province: "Eastern Region", lat: 0.45, lon: 33.20, elevation: 1133, tags: ["city", "tourism"], country: "UG", source: "seed", provinceSlug: "eastern-region-ug" },

  // ── Ethiopia (ET) ─────────────────────────────────────────────────────────
  { slug: "addis-ababa-et", name: "Addis Ababa", province: "Addis Ababa", lat: 9.03, lon: 38.74, elevation: 2355, tags: ["city", "travel"], country: "ET", source: "seed", provinceSlug: "addis-ababa-et" },
  { slug: "dire-dawa-et", name: "Dire Dawa", province: "Oromia Region", lat: 9.59, lon: 41.87, elevation: 1176, tags: ["city"], country: "ET", source: "seed", provinceSlug: "oromia-region-et" },
  { slug: "mekelle-et", name: "Mekelle", province: "Tigray Region", lat: 13.50, lon: 39.47, elevation: 2084, tags: ["city"], country: "ET", source: "seed", provinceSlug: "tigray-region-et" },
  { slug: "hawassa-et", name: "Hawassa", province: "Oromia Region", lat: 7.06, lon: 38.48, elevation: 1708, tags: ["city", "farming"], country: "ET", source: "seed", provinceSlug: "oromia-region-et" },

  // ── Rwanda (RW) ───────────────────────────────────────────────────────────
  { slug: "kigali-rw", name: "Kigali", province: "Kigali Province", lat: -1.94, lon: 30.06, elevation: 1567, tags: ["city", "travel"], country: "RW", source: "seed", provinceSlug: "kigali-province-rw" },
  { slug: "butare-rw", name: "Huye (Butare)", province: "Southern Province", lat: -2.60, lon: 29.74, elevation: 1768, tags: ["city", "education"], country: "RW", source: "seed", provinceSlug: "western-province-rw" },
  { slug: "gisenyi-rw", name: "Rubavu (Gisenyi)", province: "Western Province", lat: -1.70, lon: 29.26, elevation: 1546, tags: ["city", "tourism"], country: "RW", source: "seed", provinceSlug: "western-province-rw" },

  // ── Zambia (ZM) ───────────────────────────────────────────────────────────
  { slug: "lusaka-zm", name: "Lusaka", province: "Lusaka Province", lat: -15.42, lon: 28.28, elevation: 1279, tags: ["city", "travel"], country: "ZM", source: "seed", provinceSlug: "lusaka-province-zm" },
  { slug: "ndola-zm", name: "Ndola", province: "Copperbelt Province", lat: -12.97, lon: 28.64, elevation: 1270, tags: ["city", "mining"], country: "ZM", source: "seed", provinceSlug: "copperbelt-province-zm" },
  { slug: "kitwe-zm", name: "Kitwe", province: "Copperbelt Province", lat: -12.82, lon: 28.21, elevation: 1290, tags: ["city", "mining"], country: "ZM", source: "seed", provinceSlug: "copperbelt-province-zm" },
  { slug: "livingstone-zm", name: "Livingstone", province: "Southern Province", lat: -17.85, lon: 25.86, elevation: 989, tags: ["city", "tourism", "travel"], country: "ZM", source: "seed", provinceSlug: "southern-province-zm" },
  { slug: "chipata-zm", name: "Chipata", province: "Eastern Province", lat: -13.65, lon: 32.65, elevation: 1049, tags: ["city", "farming"], country: "ZM", source: "seed", provinceSlug: "eastern-province-zm" },

  // ── Mozambique (MZ) ───────────────────────────────────────────────────────
  { slug: "maputo-mz", name: "Maputo", province: "Maputo Province", lat: -25.97, lon: 32.59, elevation: 47, tags: ["city", "travel"], country: "MZ", source: "seed", provinceSlug: "maputo-province-mz" },
  { slug: "beira-mz", name: "Beira", province: "Sofala Province", lat: -19.84, lon: 34.84, elevation: 10, tags: ["city", "travel"], country: "MZ", source: "seed", provinceSlug: "sofala-province-mz" },
  { slug: "nampula-mz", name: "Nampula", province: "Nampula Province", lat: -15.12, lon: 39.27, elevation: 440, tags: ["city", "farming"], country: "MZ", source: "seed", provinceSlug: "nampula-province-mz" },
  { slug: "quelimane-mz", name: "Quelimane", province: "Zambezia Province", lat: -17.88, lon: 36.89, elevation: 15, tags: ["city"], country: "MZ", source: "seed", provinceSlug: "zambezia-province-mz" },

  // ── South Africa (ZA) ─────────────────────────────────────────────────────
  { slug: "johannesburg-za", name: "Johannesburg", province: "Gauteng", lat: -26.20, lon: 28.04, elevation: 1750, tags: ["city", "travel", "mining"], country: "ZA", source: "seed", provinceSlug: "gauteng-za" },
  { slug: "cape-town-za", name: "Cape Town", province: "Western Cape", lat: -33.93, lon: 18.42, elevation: 50, tags: ["city", "tourism", "travel"], country: "ZA", source: "seed", provinceSlug: "western-cape-za" },
  { slug: "durban-za", name: "Durban", province: "KwaZulu-Natal", lat: -29.86, lon: 31.02, elevation: 8, tags: ["city", "travel", "tourism"], country: "ZA", source: "seed", provinceSlug: "kwazulu-natal-za" },
  { slug: "pretoria-za", name: "Pretoria (Tshwane)", province: "Gauteng", lat: -25.75, lon: 28.19, elevation: 1339, tags: ["city"], country: "ZA", source: "seed", provinceSlug: "gauteng-za" },
  { slug: "port-elizabeth-za", name: "Gqeberha (Port Elizabeth)", province: "Eastern Cape", lat: -33.96, lon: 25.62, elevation: 65, tags: ["city", "travel"], country: "ZA", source: "seed", provinceSlug: "eastern-cape-za" },
  { slug: "polokwane-za", name: "Polokwane", province: "Limpopo", lat: -23.90, lon: 29.45, elevation: 1228, tags: ["city", "travel"], country: "ZA", source: "seed", provinceSlug: "limpopo-za" },

  // ── Botswana (BW) ─────────────────────────────────────────────────────────
  { slug: "gaborone-bw", name: "Gaborone", province: "South-East District", lat: -24.65, lon: 25.91, elevation: 994, tags: ["city", "travel"], country: "BW", source: "seed", provinceSlug: "south-east-district-bw" },
  { slug: "francistown-bw", name: "Francistown", province: "North-East District", lat: -21.17, lon: 27.51, elevation: 1000, tags: ["city", "mining"], country: "BW", source: "seed", provinceSlug: "north-east-district-bw" },
  { slug: "maun-bw", name: "Maun", province: "North-West District", lat: -19.98, lon: 23.42, elevation: 946, tags: ["city", "tourism"], country: "BW", source: "seed", provinceSlug: "central-district-bw" },

  // ── Namibia (NA) ──────────────────────────────────────────────────────────
  { slug: "windhoek-na", name: "Windhoek", province: "Khomas Region", lat: -22.56, lon: 17.08, elevation: 1655, tags: ["city", "travel"], country: "NA", source: "seed", provinceSlug: "khomas-region-na" },
  { slug: "walvis-bay-na", name: "Walvis Bay", province: "Erongo Region", lat: -22.96, lon: 14.51, elevation: 5, tags: ["city"], country: "NA", source: "seed", provinceSlug: "erongo-region-na" },
  { slug: "oshakati-na", name: "Oshakati", province: "Oshana Region", lat: -17.79, lon: 15.69, elevation: 1097, tags: ["city", "farming"], country: "NA", source: "seed", provinceSlug: "oshana-region-na" },

  // ── Angola (AO) ───────────────────────────────────────────────────────────
  { slug: "luanda-ao", name: "Luanda", province: "Luanda Province", lat: -8.84, lon: 13.23, elevation: 6, tags: ["city", "travel"], country: "AO", source: "seed", provinceSlug: "luanda-province-ao" },
  { slug: "huambo-ao", name: "Huambo", province: "Huila Province", lat: -12.77, lon: 15.74, elevation: 1700, tags: ["city", "farming"], country: "AO", source: "seed", provinceSlug: "huila-province-ao" },
  { slug: "benguela-ao", name: "Benguela", province: "Benguela Province", lat: -12.58, lon: 13.41, elevation: 33, tags: ["city"], country: "AO", source: "seed", provinceSlug: "benguela-province-ao" },

  // ── Malawi (MW) ───────────────────────────────────────────────────────────
  { slug: "lilongwe-mw", name: "Lilongwe", province: "Central Region", lat: -13.97, lon: 33.79, elevation: 1050, tags: ["city", "travel"], country: "MW", source: "seed", provinceSlug: "central-region-mw" },
  { slug: "blantyre-mw", name: "Blantyre", province: "Southern Region", lat: -15.79, lon: 35.00, elevation: 1042, tags: ["city", "education"], country: "MW", source: "seed", provinceSlug: "southern-region-mw" },
  { slug: "mzuzu-mw", name: "Mzuzu", province: "Northern Region", lat: -11.47, lon: 34.02, elevation: 1248, tags: ["city", "farming"], country: "MW", source: "seed", provinceSlug: "northern-region-mw" },

  // ── Eswatini (SZ) ─────────────────────────────────────────────────────────
  { slug: "mbabane-sz", name: "Mbabane", province: "Hhohho District", lat: -26.32, lon: 31.14, elevation: 1243, tags: ["city"], country: "SZ", source: "seed" },
  { slug: "manzini-sz", name: "Manzini", province: "Manzini District", lat: -26.50, lon: 31.37, elevation: 645, tags: ["city", "farming"], country: "SZ", source: "seed" },

  // ── Lesotho (LS) ──────────────────────────────────────────────────────────
  { slug: "maseru-ls", name: "Maseru", province: "Maseru District", lat: -29.31, lon: 27.48, elevation: 1528, tags: ["city"], country: "LS", source: "seed" },

  // ── Ghana (GH) ────────────────────────────────────────────────────────────
  { slug: "accra-gh", name: "Accra", province: "Greater Accra Region", lat: 5.56, lon: -0.20, elevation: 61, tags: ["city", "travel"], country: "GH", source: "seed", provinceSlug: "greater-accra-region-gh" },
  { slug: "kumasi-gh", name: "Kumasi", province: "Ashanti Region", lat: 6.69, lon: -1.62, elevation: 270, tags: ["city", "farming"], country: "GH", source: "seed", provinceSlug: "ashanti-region-gh" },
  { slug: "tamale-gh", name: "Tamale", province: "Northern Region", lat: 9.40, lon: -0.84, elevation: 183, tags: ["city", "farming"], country: "GH", source: "seed", provinceSlug: "northern-region-gh" },
  { slug: "takoradi-gh", name: "Takoradi", province: "Western Region", lat: 4.90, lon: -1.75, elevation: 4, tags: ["city", "mining"], country: "GH", source: "seed" },

  // ── Nigeria (NG) ──────────────────────────────────────────────────────────
  { slug: "lagos-ng", name: "Lagos", province: "Lagos State", lat: 6.45, lon: 3.40, elevation: 41, tags: ["city", "travel"], country: "NG", source: "seed", provinceSlug: "lagos-state-ng" },
  { slug: "abuja-ng", name: "Abuja", province: "Abuja FCT", lat: 9.07, lon: 7.40, elevation: 840, tags: ["city"], country: "NG", source: "seed", provinceSlug: "abuja-fct-ng" },
  { slug: "kano-ng", name: "Kano", province: "Kano State", lat: 12.00, lon: 8.52, elevation: 475, tags: ["city", "farming"], country: "NG", source: "seed", provinceSlug: "kano-state-ng" },
  { slug: "port-harcourt-ng", name: "Port Harcourt", province: "Rivers State", lat: 4.77, lon: 7.01, elevation: 10, tags: ["city", "mining"], country: "NG", source: "seed", provinceSlug: "rivers-state-ng" },
  { slug: "ibadan-ng", name: "Ibadan", province: "Oyo State", lat: 7.39, lon: 3.92, elevation: 234, tags: ["city", "farming"], country: "NG", source: "seed" },

  // ── Senegal (SN) ──────────────────────────────────────────────────────────
  { slug: "dakar-sn", name: "Dakar", province: "Dakar Region", lat: 14.69, lon: -17.45, elevation: 22, tags: ["city", "travel"], country: "SN", source: "seed", provinceSlug: "dakar-region-sn" },
  { slug: "thies-sn", name: "Thies", province: "Thies Region", lat: 14.80, lon: -16.94, elevation: 73, tags: ["city", "farming"], country: "SN", source: "seed", provinceSlug: "thies-region-sn" },
  { slug: "saint-louis-sn", name: "Saint-Louis", province: "Saint-Louis Region", lat: 16.02, lon: -16.49, elevation: 4, tags: ["city", "tourism"], country: "SN", source: "seed" },

  // ── Cote d'Ivoire (CI) ────────────────────────────────────────────────────
  { slug: "abidjan-ci", name: "Abidjan", province: "Abidjan District", lat: 5.34, lon: -4.03, elevation: 23, tags: ["city", "travel"], country: "CI", source: "seed", provinceSlug: "abidjan-district-ci" },
  { slug: "yamoussoukro-ci", name: "Yamoussoukro", province: "Lagunes District", lat: 6.82, lon: -5.27, elevation: 220, tags: ["city"], country: "CI", source: "seed", provinceSlug: "lagunes-district-ci" },
  { slug: "bouake-ci", name: "Bouake", province: "Gbeke Region", lat: 7.69, lon: -5.03, elevation: 378, tags: ["city", "farming"], country: "CI", source: "seed" },

  // ── Cameroon (CM) ─────────────────────────────────────────────────────────
  { slug: "yaounde-cm", name: "Yaounde", province: "Centre Region", lat: 3.87, lon: 11.52, elevation: 726, tags: ["city", "travel"], country: "CM", source: "seed", provinceSlug: "centre-region-cm" },
  { slug: "douala-cm", name: "Douala", province: "Littoral Region", lat: 4.05, lon: 9.70, elevation: 9, tags: ["city", "travel"], country: "CM", source: "seed", provinceSlug: "littoral-region-cm" },
  { slug: "garoua-cm", name: "Garoua", province: "North Region", lat: 9.30, lon: 13.40, elevation: 252, tags: ["city", "farming"], country: "CM", source: "seed" },

  // ── DR Congo (CD) ─────────────────────────────────────────────────────────
  { slug: "kinshasa-cd", name: "Kinshasa", province: "Kinshasa Province", lat: -4.32, lon: 15.32, elevation: 316, tags: ["city", "travel"], country: "CD", source: "seed", provinceSlug: "kinshasa-province-cd" },
  { slug: "lubumbashi-cd", name: "Lubumbashi", province: "Haut-Katanga Province", lat: -11.67, lon: 27.47, elevation: 1278, tags: ["city", "mining"], country: "CD", source: "seed", provinceSlug: "haut-katanga-province-cd" },
  { slug: "goma-cd", name: "Goma", province: "Nord-Kivu Province", lat: -1.68, lon: 29.22, elevation: 1490, tags: ["city"], country: "CD", source: "seed", provinceSlug: "nord-kivu-province-cd" },
  { slug: "mbuji-mayi-cd", name: "Mbuji-Mayi", province: "Kasai-Oriental Province", lat: -6.15, lon: 23.60, elevation: 619, tags: ["city", "mining"], country: "CD", source: "seed" },

  // ── Egypt (EG) ────────────────────────────────────────────────────────────
  { slug: "cairo-eg", name: "Cairo", province: "Cairo Governorate", lat: 30.06, lon: 31.25, elevation: 23, tags: ["city", "tourism", "travel"], country: "EG", source: "seed", provinceSlug: "cairo-governorate-eg" },
  { slug: "alexandria-eg", name: "Alexandria", province: "Alexandria Governorate", lat: 31.20, lon: 29.92, elevation: 5, tags: ["city", "travel", "tourism"], country: "EG", source: "seed", provinceSlug: "alexandria-governorate-eg" },
  { slug: "giza-eg", name: "Giza", province: "Giza Governorate", lat: 30.01, lon: 31.21, elevation: 19, tags: ["city", "tourism"], country: "EG", source: "seed", provinceSlug: "giza-governorate-eg" },
  { slug: "luxor-eg", name: "Luxor", province: "Luxor Governorate", lat: 25.69, lon: 32.65, elevation: 76, tags: ["city", "tourism"], country: "EG", source: "seed" },
  { slug: "aswan-eg", name: "Aswan", province: "Aswan Governorate", lat: 24.09, lon: 32.90, elevation: 85, tags: ["city", "tourism"], country: "EG", source: "seed" },

  // ── Morocco (MA) ──────────────────────────────────────────────────────────
  { slug: "casablanca-ma", name: "Casablanca", province: "Casablanca-Settat", lat: 33.59, lon: -7.62, elevation: 56, tags: ["city", "travel"], country: "MA", source: "seed", provinceSlug: "casablanca-settat-ma" },
  { slug: "rabat-ma", name: "Rabat", province: "Rabat-Sale-Kenitra", lat: 33.99, lon: -6.85, elevation: 75, tags: ["city"], country: "MA", source: "seed", provinceSlug: "rabat-sale-kenitra-ma" },
  { slug: "marrakech-ma", name: "Marrakech", province: "Marrakech-Safi", lat: 31.63, lon: -8.00, elevation: 466, tags: ["city", "tourism"], country: "MA", source: "seed", provinceSlug: "marrakech-safi-ma" },
  { slug: "fes-ma", name: "Fes", province: "Fes-Meknes", lat: 34.03, lon: -5.00, elevation: 414, tags: ["city", "tourism"], country: "MA", source: "seed" },
  { slug: "tangier-ma", name: "Tangier", province: "Tanger-Tetouan-Al Hoceima", lat: 35.77, lon: -5.80, elevation: 50, tags: ["city", "travel"], country: "MA", source: "seed" },

  // ── Tunisia (TN) ──────────────────────────────────────────────────────────
  { slug: "tunis-tn", name: "Tunis", province: "Tunis Governorate", lat: 36.82, lon: 10.17, elevation: 4, tags: ["city", "tourism", "travel"], country: "TN", source: "seed", provinceSlug: "tunis-governorate-tn" },
  { slug: "sfax-tn", name: "Sfax", province: "Sfax Governorate", lat: 34.74, lon: 10.76, elevation: 24, tags: ["city", "farming"], country: "TN", source: "seed", provinceSlug: "sfax-governorate-tn" },
  { slug: "sousse-tn", name: "Sousse", province: "Sousse Governorate", lat: 35.83, lon: 10.64, elevation: 6, tags: ["city", "tourism"], country: "TN", source: "seed" },

  // ── Algeria (DZ) ──────────────────────────────────────────────────────────
  { slug: "algiers-dz", name: "Algiers", province: "Algiers Province", lat: 36.74, lon: 3.06, elevation: 24, tags: ["city", "travel"], country: "DZ", source: "seed" },
  { slug: "oran-dz", name: "Oran", province: "Oran Province", lat: 35.69, lon: -0.63, elevation: 5, tags: ["city"], country: "DZ", source: "seed" },
  { slug: "constantine-dz", name: "Constantine", province: "Constantine Province", lat: 36.37, lon: 6.61, elevation: 662, tags: ["city", "education"], country: "DZ", source: "seed" },

  // ── Sudan (SD) ────────────────────────────────────────────────────────────
  { slug: "khartoum-sd", name: "Khartoum", province: "Khartoum State", lat: 15.55, lon: 32.53, elevation: 381, tags: ["city"], country: "SD", source: "seed" },
  { slug: "omdurman-sd", name: "Omdurman", province: "Khartoum State", lat: 15.61, lon: 32.48, elevation: 380, tags: ["city"], country: "SD", source: "seed" },
  { slug: "port-sudan-sd", name: "Port Sudan", province: "Red Sea State", lat: 19.62, lon: 37.22, elevation: 5, tags: ["city", "travel"], country: "SD", source: "seed" },

  // ── South Sudan (SS) ──────────────────────────────────────────────────────
  { slug: "juba-ss", name: "Juba", province: "Central Equatoria", lat: 4.86, lon: 31.57, elevation: 457, tags: ["city"], country: "SS", source: "seed" },

  // ── Somalia (SO) ──────────────────────────────────────────────────────────
  { slug: "mogadishu-so", name: "Mogadishu", province: "Banaadir Region", lat: 2.05, lon: 45.34, elevation: 9, tags: ["city"], country: "SO", source: "seed" },
  { slug: "hargeisa-so", name: "Hargeisa", province: "Woqooyi Galbeed", lat: 9.56, lon: 44.07, elevation: 1334, tags: ["city"], country: "SO", source: "seed" },

  // ── Djibouti (DJ) ─────────────────────────────────────────────────────────
  { slug: "djibouti-city-dj", name: "Djibouti City", province: "Djibouti Region", lat: 11.59, lon: 43.15, elevation: 19, tags: ["city", "travel"], country: "DJ", source: "seed" },

  // ── Eritrea (ER) ──────────────────────────────────────────────────────────
  { slug: "asmara-er", name: "Asmara", province: "Maekel Region", lat: 15.34, lon: 38.93, elevation: 2325, tags: ["city"], country: "ER", source: "seed" },

  // ── Burundi (BI) ──────────────────────────────────────────────────────────
  { slug: "bujumbura-bi", name: "Bujumbura", province: "Bujumbura Mairie", lat: -3.38, lon: 29.36, elevation: 782, tags: ["city"], country: "BI", source: "seed" },
  { slug: "gitega-bi", name: "Gitega", province: "Gitega Province", lat: -3.43, lon: 29.92, elevation: 1616, tags: ["city"], country: "BI", source: "seed" },

  // ── Comoros (KM) ──────────────────────────────────────────────────────────
  { slug: "moroni-km", name: "Moroni", province: "Grande Comore", lat: -11.70, lon: 43.26, elevation: 29, tags: ["city"], country: "KM", source: "seed" },

  // ── Madagascar (MG) ───────────────────────────────────────────────────────
  { slug: "antananarivo-mg", name: "Antananarivo", province: "Analamanga Region", lat: -18.91, lon: 47.54, elevation: 1279, tags: ["city", "travel"], country: "MG", source: "seed" },
  { slug: "toamasina-mg", name: "Toamasina", province: "Atsinanana Region", lat: -18.16, lon: 49.40, elevation: 5, tags: ["city"], country: "MG", source: "seed" },

  // ── Mauritius (MU) ────────────────────────────────────────────────────────
  { slug: "port-louis-mu", name: "Port Louis", province: "Port Louis District", lat: -20.16, lon: 57.50, elevation: 5, tags: ["city", "tourism"], country: "MU", source: "seed" },

  // ── Seychelles (SC) ───────────────────────────────────────────────────────
  { slug: "victoria-sc", name: "Victoria", province: "Mahe Island", lat: -4.62, lon: 55.45, elevation: 3, tags: ["city", "tourism"], country: "SC", source: "seed" },

  // ── Burkina Faso (BF) ─────────────────────────────────────────────────────
  { slug: "ouagadougou-bf", name: "Ouagadougou", province: "Centre Region", lat: 12.36, lon: -1.53, elevation: 306, tags: ["city"], country: "BF", source: "seed" },
  { slug: "bobo-dioulasso-bf", name: "Bobo-Dioulasso", province: "Hauts-Bassins Region", lat: 11.18, lon: -4.30, elevation: 454, tags: ["city", "farming"], country: "BF", source: "seed" },

  // ── Mali (ML) ─────────────────────────────────────────────────────────────
  { slug: "bamako-ml", name: "Bamako", province: "Bamako Capital District", lat: 12.65, lon: -8.00, elevation: 380, tags: ["city"], country: "ML", source: "seed" },
  { slug: "timbuktu-ml", name: "Timbuktu", province: "Tombouctou Region", lat: 16.77, lon: -3.01, elevation: 261, tags: ["city", "tourism"], country: "ML", source: "seed" },

  // ── Niger (NE) ────────────────────────────────────────────────────────────
  { slug: "niamey-ne", name: "Niamey", province: "Niamey Region", lat: 13.51, lon: 2.12, elevation: 218, tags: ["city"], country: "NE", source: "seed" },
  { slug: "zinder-ne", name: "Zinder", province: "Zinder Region", lat: 13.81, lon: 8.99, elevation: 447, tags: ["city", "farming"], country: "NE", source: "seed" },

  // ── Benin (BJ) ────────────────────────────────────────────────────────────
  { slug: "cotonou-bj", name: "Cotonou", province: "Littoral Department", lat: 6.37, lon: 2.42, elevation: 9, tags: ["city", "travel"], country: "BJ", source: "seed" },
  { slug: "porto-novo-bj", name: "Porto-Novo", province: "Oueme Department", lat: 6.37, lon: 2.61, elevation: 25, tags: ["city"], country: "BJ", source: "seed" },

  // ── Togo (TG) ─────────────────────────────────────────────────────────────
  { slug: "lome-tg", name: "Lome", province: "Maritime Region", lat: 6.14, lon: 1.22, elevation: 25, tags: ["city", "travel"], country: "TG", source: "seed" },
  { slug: "sokode-tg", name: "Sokode", province: "Centrale Region", lat: 8.98, lon: 1.13, elevation: 411, tags: ["city"], country: "TG", source: "seed" },

  // ── Liberia (LR) ──────────────────────────────────────────────────────────
  { slug: "monrovia-lr", name: "Monrovia", province: "Montserrado County", lat: 6.29, lon: -10.77, elevation: 8, tags: ["city", "travel"], country: "LR", source: "seed" },

  // ── Sierra Leone (SL) ─────────────────────────────────────────────────────
  { slug: "freetown-sl", name: "Freetown", province: "Western Area", lat: 8.49, lon: -13.23, elevation: 30, tags: ["city", "travel"], country: "SL", source: "seed" },

  // ── Guinea (GN) ───────────────────────────────────────────────────────────
  { slug: "conakry-gn", name: "Conakry", province: "Conakry Region", lat: 9.54, lon: -13.68, elevation: 26, tags: ["city", "mining"], country: "GN", source: "seed" },

  // ── Guinea-Bissau (GW) ────────────────────────────────────────────────────
  { slug: "bissau-gw", name: "Bissau", province: "Bissau Region", lat: 11.86, lon: -15.60, elevation: 14, tags: ["city"], country: "GW", source: "seed" },

  // ── Gambia (GM) ───────────────────────────────────────────────────────────
  { slug: "banjul-gm", name: "Banjul", province: "Banjul Division", lat: 13.45, lon: -16.58, elevation: 5, tags: ["city"], country: "GM", source: "seed" },

  // ── Mauritania (MR) ───────────────────────────────────────────────────────
  { slug: "nouakchott-mr", name: "Nouakchott", province: "Nouakchott Region", lat: 18.08, lon: -15.97, elevation: 5, tags: ["city"], country: "MR", source: "seed" },
  { slug: "nouadhibou-mr", name: "Nouadhibou", province: "Dakhlet Nouadhibou", lat: 20.93, lon: -17.04, elevation: 4, tags: ["city", "mining"], country: "MR", source: "seed" },

  // ── Cabo Verde (CV) ───────────────────────────────────────────────────────
  { slug: "praia-cv", name: "Praia", province: "Santiago Island", lat: 14.93, lon: -23.52, elevation: 27, tags: ["city"], country: "CV", source: "seed" },

  // ── Gabon (GA) ────────────────────────────────────────────────────────────
  { slug: "libreville-ga", name: "Libreville", province: "Estuaire Province", lat: 0.39, lon: 9.45, elevation: 9, tags: ["city", "travel"], country: "GA", source: "seed" },
  { slug: "port-gentil-ga", name: "Port-Gentil", province: "Ogooue-Maritime Province", lat: -0.72, lon: 8.78, elevation: 5, tags: ["city", "mining"], country: "GA", source: "seed" },

  // ── Republic of Congo (CG) ────────────────────────────────────────────────
  { slug: "brazzaville-cg", name: "Brazzaville", province: "Brazzaville Department", lat: -4.27, lon: 15.27, elevation: 316, tags: ["city"], country: "CG", source: "seed" },
  { slug: "pointe-noire-cg", name: "Pointe-Noire", province: "Kouilou Department", lat: -4.78, lon: 11.86, elevation: 17, tags: ["city", "mining"], country: "CG", source: "seed" },

  // ── Central African Republic (CF) ────────────────────────────────────────
  { slug: "bangui-cf", name: "Bangui", province: "Ombella-Mpoko Prefecture", lat: 4.36, lon: 18.56, elevation: 369, tags: ["city"], country: "CF", source: "seed" },

  // ── Chad (TD) ─────────────────────────────────────────────────────────────
  { slug: "ndjamena-td", name: "N'Djamena", province: "Chari-Baguirmi", lat: 12.11, lon: 15.05, elevation: 295, tags: ["city"], country: "TD", source: "seed" },
  { slug: "moundou-td", name: "Moundou", province: "Logone Occidental", lat: 8.57, lon: 16.08, elevation: 418, tags: ["city", "farming"], country: "TD", source: "seed" },

  // ── Equatorial Guinea (GQ) ───────────────────────────────────────────────
  { slug: "malabo-gq", name: "Malabo", province: "Bioko Norte Province", lat: 3.75, lon: 8.78, elevation: 30, tags: ["city"], country: "GQ", source: "seed" },

  // ── Sao Tome and Principe (ST) ───────────────────────────────────────────
  { slug: "sao-tome-st", name: "Sao Tome", province: "Sao Tome Island", lat: 0.34, lon: 6.73, elevation: 9, tags: ["city"], country: "ST", source: "seed" },

  // ── Libya (LY) ────────────────────────────────────────────────────────────
  { slug: "tripoli-ly", name: "Tripoli", province: "Tripoli District", lat: 32.90, lon: 13.18, elevation: 81, tags: ["city"], country: "LY", source: "seed" },
  { slug: "benghazi-ly", name: "Benghazi", province: "Benghazi District", lat: 32.12, lon: 20.07, elevation: 32, tags: ["city"], country: "LY", source: "seed" },

  // ── Reunion (RE) ──────────────────────────────────────────────────────────
  { slug: "saint-denis-re", name: "Saint-Denis", province: "Reunion Island", lat: -20.88, lon: 55.45, elevation: 77, tags: ["city", "tourism"], country: "RE", source: "seed" },

  // ── Mayotte (YT) ──────────────────────────────────────────────────────────
  { slug: "mamoudzou-yt", name: "Mamoudzou", province: "Mayotte Island", lat: -12.78, lon: 45.23, elevation: 26, tags: ["city"], country: "YT", source: "seed" },

  // ── Thailand (TH) ─────────────────────────────────────────────────────────
  { slug: "bangkok-th", name: "Bangkok", province: "Bangkok", lat: 13.75, lon: 100.52, elevation: 5, tags: ["city", "travel", "tourism"], country: "TH", source: "seed", provinceSlug: "bangkok-th" },
  { slug: "chiang-mai-th", name: "Chiang Mai", province: "Chiang Mai Province", lat: 18.79, lon: 98.98, elevation: 310, tags: ["city", "tourism", "travel"], country: "TH", source: "seed", provinceSlug: "chiang-mai-province-th" },
  { slug: "phuket-th", name: "Phuket", province: "Phuket Province", lat: 7.88, lon: 98.40, elevation: 2, tags: ["city", "tourism"], country: "TH", source: "seed", provinceSlug: "phuket-province-th" },
  { slug: "pattaya-th", name: "Pattaya", province: "Chonburi Province", lat: 12.93, lon: 100.88, elevation: 5, tags: ["city", "tourism"], country: "TH", source: "seed" },
  { slug: "hat-yai-th", name: "Hat Yai", province: "Songkhla Province", lat: 7.01, lon: 100.48, elevation: 18, tags: ["city", "travel"], country: "TH", source: "seed" },

  // ── Malaysia (MY) ─────────────────────────────────────────────────────────
  { slug: "kuala-lumpur-my", name: "Kuala Lumpur", province: "Kuala Lumpur", lat: 3.14, lon: 101.69, elevation: 66, tags: ["city", "travel"], country: "MY", source: "seed", provinceSlug: "kuala-lumpur-my" },
  { slug: "george-town-my", name: "George Town (Penang)", province: "Penang", lat: 5.41, lon: 100.34, elevation: 5, tags: ["city", "tourism"], country: "MY", source: "seed", provinceSlug: "penang-my" },
  { slug: "johor-bahru-my", name: "Johor Bahru", province: "Johor", lat: 1.46, lon: 103.76, elevation: 14, tags: ["city", "travel"], country: "MY", source: "seed" },
  { slug: "kota-kinabalu-my", name: "Kota Kinabalu", province: "Sabah", lat: 5.98, lon: 116.07, elevation: 3, tags: ["city", "tourism"], country: "MY", source: "seed" },

  // ── Indonesia (ID) ────────────────────────────────────────────────────────
  { slug: "jakarta-id", name: "Jakarta", province: "DKI Jakarta", lat: -6.21, lon: 106.85, elevation: 8, tags: ["city", "travel"], country: "ID", source: "seed", provinceSlug: "dki-jakarta-id" },
  { slug: "surabaya-id", name: "Surabaya", province: "East Java", lat: -7.25, lon: 112.75, elevation: 5, tags: ["city"], country: "ID", source: "seed", provinceSlug: "east-java-id" },
  { slug: "bandung-id", name: "Bandung", province: "West Java", lat: -6.92, lon: 107.61, elevation: 768, tags: ["city"], country: "ID", source: "seed", provinceSlug: "west-java-id" },
  { slug: "bali-denpasar-id", name: "Denpasar (Bali)", province: "Bali", lat: -8.65, lon: 115.22, elevation: 28, tags: ["city", "tourism"], country: "ID", source: "seed", provinceSlug: "bali-id" },
  { slug: "medan-id", name: "Medan", province: "North Sumatra", lat: 3.59, lon: 98.67, elevation: 25, tags: ["city", "farming"], country: "ID", source: "seed" },

  // ── Philippines (PH) ──────────────────────────────────────────────────────
  { slug: "manila-ph", name: "Manila", province: "Metro Manila", lat: 14.60, lon: 120.98, elevation: 16, tags: ["city", "travel"], country: "PH", source: "seed", provinceSlug: "metro-manila-ph" },
  { slug: "cebu-city-ph", name: "Cebu City", province: "Cebu Province", lat: 10.32, lon: 123.90, elevation: 14, tags: ["city", "tourism"], country: "PH", source: "seed", provinceSlug: "cebu-province-ph" },
  { slug: "davao-city-ph", name: "Davao City", province: "Davao del Sur", lat: 7.07, lon: 125.61, elevation: 20, tags: ["city", "farming"], country: "PH", source: "seed", provinceSlug: "davao-del-sur-ph" },
  { slug: "quezon-city-ph", name: "Quezon City", province: "Metro Manila", lat: 14.68, lon: 121.04, elevation: 61, tags: ["city"], country: "PH", source: "seed", provinceSlug: "metro-manila-ph" },

  // ── Vietnam (VN) ──────────────────────────────────────────────────────────
  { slug: "hanoi-vn", name: "Hanoi", province: "Hanoi", lat: 21.03, lon: 105.85, elevation: 5, tags: ["city", "travel"], country: "VN", source: "seed", provinceSlug: "hanoi-vn" },
  { slug: "ho-chi-minh-city-vn", name: "Ho Chi Minh City", province: "Ho Chi Minh City", lat: 10.82, lon: 106.63, elevation: 19, tags: ["city", "travel"], country: "VN", source: "seed", provinceSlug: "ho-chi-minh-city-vn" },
  { slug: "da-nang-vn", name: "Da Nang", province: "Da Nang", lat: 16.05, lon: 108.22, elevation: 5, tags: ["city", "tourism"], country: "VN", source: "seed", provinceSlug: "da-nang-vn" },
  { slug: "hoi-an-vn", name: "Hoi An", province: "Quang Nam Province", lat: 15.88, lon: 108.33, elevation: 5, tags: ["city", "tourism"], country: "VN", source: "seed" },

  // ── Singapore (SG) ────────────────────────────────────────────────────────
  { slug: "singapore-sg", name: "Singapore", province: "Central Region", lat: 1.35, lon: 103.82, elevation: 15, tags: ["city", "travel"], country: "SG", source: "seed" },

  // ── Myanmar (MM) ──────────────────────────────────────────────────────────
  { slug: "yangon-mm", name: "Yangon", province: "Yangon Region", lat: 16.87, lon: 96.20, elevation: 11, tags: ["city", "travel"], country: "MM", source: "seed" },
  { slug: "mandalay-mm", name: "Mandalay", province: "Mandalay Region", lat: 21.97, lon: 96.08, elevation: 73, tags: ["city", "tourism"], country: "MM", source: "seed" },
  { slug: "naypyidaw-mm", name: "Naypyidaw", province: "Naypyidaw Union Territory", lat: 19.74, lon: 96.13, elevation: 110, tags: ["city"], country: "MM", source: "seed" },

  // ── Cambodia (KH) ─────────────────────────────────────────────────────────
  { slug: "phnom-penh-kh", name: "Phnom Penh", province: "Phnom Penh", lat: 11.56, lon: 104.92, elevation: 12, tags: ["city", "travel"], country: "KH", source: "seed" },
  { slug: "siem-reap-kh", name: "Siem Reap", province: "Siem Reap Province", lat: 13.36, lon: 103.86, elevation: 12, tags: ["city", "tourism"], country: "KH", source: "seed" },

  // ── Laos (LA) ─────────────────────────────────────────────────────────────
  { slug: "vientiane-la", name: "Vientiane", province: "Vientiane Prefecture", lat: 17.97, lon: 102.60, elevation: 174, tags: ["city", "travel"], country: "LA", source: "seed" },
  { slug: "luang-prabang-la", name: "Luang Prabang", province: "Luang Prabang Province", lat: 19.89, lon: 102.13, elevation: 289, tags: ["city", "tourism"], country: "LA", source: "seed" },

  // ── Brunei (BN) ───────────────────────────────────────────────────────────
  { slug: "bandar-seri-begawan-bn", name: "Bandar Seri Begawan", province: "Brunei-Muara District", lat: 4.94, lon: 114.95, elevation: 8, tags: ["city"], country: "BN", source: "seed" },

  // ── Timor-Leste (TL) ──────────────────────────────────────────────────────
  { slug: "dili-tl", name: "Dili", province: "Dili Municipality", lat: -8.56, lon: 125.58, elevation: 9, tags: ["city"], country: "TL", source: "seed" },
];
