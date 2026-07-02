/**
 * Maps location slugs to ICAO airport codes.
 * Also provides nearest-airport lookup by lat/lon for locations
 * not in the slug map (community-created GPS locations, etc.).
 *
 * Coordinates are the airport reference point (WGS 84, decimal degrees),
 * verified against OurAirports / the Great Circle Mapper.
 */

interface Airport {
  icao: string;
  name: string;
  lat: number;
  lon: number;
}

/** A nearby airport with its great-circle distance from the query point. */
export interface AirportDistance {
  icao: string;
  name: string;
  distanceKm: number;
}

/** ICAO airports with coordinates for distance lookup and METAR/TAF briefings. */
const AIRPORTS: Airport[] = [
  // Zimbabwe
  { icao: "FVHA", name: "Harare (Robert Gabriel Mugabe Intl)", lat: -17.932, lon: 31.093 },
  { icao: "FVBU", name: "Bulawayo (Joshua Mqabuko Nkomo Intl)", lat: -20.017, lon: 28.618 },
  { icao: "FVFA", name: "Victoria Falls Intl", lat: -18.096, lon: 25.839 },
  { icao: "FVMV", name: "Masvingo", lat: -20.055, lon: 30.859 },
  { icao: "FVGW", name: "Gweru (Thornhill)", lat: -19.436, lon: 29.861 },
  { icao: "FVMU", name: "Mutare", lat: -18.998, lon: 32.627 },
  { icao: "FVGR", name: "Grand Reef (Mutare)", lat: -18.976, lon: 32.449 },
  { icao: "FVKB", name: "Kariba", lat: -16.520, lon: 28.885 },
  { icao: "FVWN", name: "Hwange National Park", lat: -18.630, lon: 27.021 },
  { icao: "FVKK", name: "Kwekwe", lat: -18.933, lon: 29.841 }, // corrected lon (was 29.738)
  { icao: "FVBB", name: "Beitbridge", lat: -22.198, lon: 30.013 }, // corrected lon (was 29.433)
  { icao: "FVBD", name: "Bindura", lat: -17.304, lon: 31.327 }, // corrected lat (was -17.175)
  { icao: "FVCH", name: "Chipinge", lat: -20.207, lon: 32.628 }, // was mislabelled "Chinhoyi"
  { icao: "FVCI", name: "Chinhoyi", lat: -17.362, lon: 30.199 }, // Chinhoyi's actual ICAO
  { icao: "FVBR", name: "Buffalo Range (Chiredzi)", lat: -21.001, lon: 31.579 },
  { icao: "FVCP", name: "Charles Prince (Harare)", lat: -17.752, lon: 30.925 },

  // Southern Africa
  { icao: "FAJS", name: "Johannesburg (O.R. Tambo Intl)", lat: -26.139, lon: 28.246 },
  { icao: "FACT", name: "Cape Town Intl", lat: -33.965, lon: 18.602 },
  { icao: "FALE", name: "Durban (King Shaka Intl)", lat: -29.615, lon: 31.119 },
  { icao: "FAPE", name: "Gqeberha (Chief Dawid Stuurman Intl)", lat: -33.985, lon: 25.617 },
  { icao: "FABL", name: "Bloemfontein (Bram Fischer Intl)", lat: -29.093, lon: 26.302 },
  { icao: "FAKN", name: "Mbombela (Kruger Mpumalanga Intl)", lat: -25.383, lon: 31.105 },
  { icao: "FAGG", name: "George", lat: -34.006, lon: 22.379 },
  { icao: "FAUP", name: "Upington", lat: -28.399, lon: 21.260 },
  { icao: "FLKK", name: "Lusaka (Kenneth Kaunda Intl)", lat: -15.331, lon: 28.453 }, // FLLS is the retired code
  { icao: "FLLI", name: "Livingstone", lat: -17.822, lon: 25.822 },
  { icao: "FLND", name: "Ndola (Simon Mwansa Kapwepwe Intl)", lat: -12.998, lon: 28.665 },
  { icao: "FBSK", name: "Gaborone (Sir Seretse Khama Intl)", lat: -24.555, lon: 25.918 },
  { icao: "FBMN", name: "Maun", lat: -19.973, lon: 23.431 },
  { icao: "FBKE", name: "Kasane", lat: -17.833, lon: 25.162 },
  { icao: "FBFT", name: "Francistown", lat: -21.160, lon: 27.475 },
  { icao: "FYWH", name: "Windhoek (Hosea Kutako Intl)", lat: -22.480, lon: 17.471 },
  { icao: "FYWB", name: "Walvis Bay", lat: -22.980, lon: 14.645 },
  { icao: "FWKI", name: "Lilongwe (Kamuzu Intl)", lat: -13.789, lon: 33.781 },
  { icao: "FWCL", name: "Blantyre (Chileka Intl)", lat: -15.679, lon: 34.974 },
  { icao: "FQMA", name: "Maputo Intl", lat: -25.921, lon: 32.573 },
  { icao: "FQBR", name: "Beira", lat: -19.796, lon: 34.908 },
  { icao: "FQNP", name: "Nampula", lat: -15.106, lon: 39.282 },
  { icao: "FQTT", name: "Tete (Chingodzi)", lat: -16.105, lon: 33.640 },
  { icao: "FNLU", name: "Luanda (Quatro de Fevereiro Intl)", lat: -8.858, lon: 13.231 },
  { icao: "FDSK", name: "Eswatini (King Mswati III Intl)", lat: -26.359, lon: 31.717 },
  { icao: "FXMM", name: "Maseru (Moshoeshoe I Intl)", lat: -29.462, lon: 27.553 },

  // Rest of Africa
  { icao: "HKJK", name: "Nairobi (Jomo Kenyatta Intl)", lat: -1.319, lon: 36.928 },
  { icao: "DNMM", name: "Lagos (Murtala Muhammed Intl)", lat: 6.577, lon: 3.321 },
  { icao: "HECA", name: "Cairo Intl", lat: 30.122, lon: 31.406 },
  { icao: "HTDA", name: "Dar es Salaam (Julius Nyerere Intl)", lat: -6.878, lon: 39.203 },
  { icao: "HAAB", name: "Addis Ababa (Bole Intl)", lat: 8.978, lon: 38.799 },
  { icao: "DGAA", name: "Accra (Kotoka Intl)", lat: 5.605, lon: -0.167 },
  { icao: "HUEN", name: "Kampala (Entebbe Intl)", lat: 0.042, lon: 32.444 },
  { icao: "HRYR", name: "Kigali Intl", lat: -1.968, lon: 30.139 },
  { icao: "GOBD", name: "Dakar (Blaise Diagne Intl)", lat: 14.671, lon: -17.073 }, // GOOY (old Yoff) is closed to scheduled traffic
  { icao: "DIAP", name: "Abidjan (Félix Houphouët-Boigny Intl)", lat: 5.261, lon: -3.926 },
  { icao: "FKKD", name: "Douala Intl", lat: 4.007, lon: 9.719 },
  { icao: "FMMI", name: "Antananarivo (Ivato Intl)", lat: -18.797, lon: 47.479 },
  { icao: "FIMP", name: "Mauritius (Sir Seewoosagur Ramgoolam Intl)", lat: -20.430, lon: 57.683 },

  // Major international hubs
  { icao: "EGLL", name: "London Heathrow", lat: 51.470, lon: -0.454 },
  { icao: "EDDF", name: "Frankfurt", lat: 50.033, lon: 8.570 },
  { icao: "EHAM", name: "Amsterdam Schiphol", lat: 52.309, lon: 4.764 },
  { icao: "LFPG", name: "Paris (Charles de Gaulle)", lat: 49.010, lon: 2.548 },
  { icao: "LTFM", name: "Istanbul", lat: 41.275, lon: 28.752 },
  { icao: "OMDB", name: "Dubai Intl", lat: 25.253, lon: 55.364 },
  { icao: "OTHH", name: "Doha (Hamad Intl)", lat: 25.273, lon: 51.608 },
  { icao: "OMAA", name: "Abu Dhabi Intl", lat: 24.433, lon: 54.651 },
  { icao: "KJFK", name: "New York (John F. Kennedy Intl)", lat: 40.640, lon: -73.779 },
  { icao: "ZGGG", name: "Guangzhou (Baiyun Intl)", lat: 23.392, lon: 113.299 },

  // ASEAN / South Asia
  { icao: "VTBS", name: "Bangkok (Suvarnabhumi)", lat: 13.681, lon: 100.747 },
  { icao: "WSSS", name: "Singapore (Changi)", lat: 1.350, lon: 103.994 },
  { icao: "WMKK", name: "Kuala Lumpur Intl", lat: 2.746, lon: 101.710 },
  { icao: "WIII", name: "Jakarta (Soekarno-Hatta Intl)", lat: -6.126, lon: 106.656 },
  { icao: "RPLL", name: "Manila (Ninoy Aquino Intl)", lat: 14.508, lon: 121.020 },
  { icao: "VGHS", name: "Dhaka (Hazrat Shahjalal Intl)", lat: 23.843, lon: 90.398 },
  { icao: "VCBI", name: "Colombo (Bandaranaike Intl)", lat: 7.181, lon: 79.885 },
];

/** Fast ICAO → airport lookup (built once from AIRPORTS). */
const AIRPORT_BY_ICAO: Record<string, Airport> = Object.fromEntries(
  AIRPORTS.map((a) => [a.icao, a]),
);

/** Slug→ICAO for seed locations (fast O(1) lookup) */
const ICAO_MAP: Record<string, string> = {
  // Zimbabwe
  harare: "FVHA", bulawayo: "FVBU", "victoria-falls": "FVFA",
  masvingo: "FVMV", gweru: "FVGW", mutare: "FVMU", kariba: "FVKB",
  "hwange-national-park": "FVWN", hwange: "FVWN", kwekwe: "FVKK",
  beitbridge: "FVBB", bindura: "FVBD", chinhoyi: "FVCI", chipinge: "FVCH",
  "buffalo-range": "FVBR",
  // Southern Africa
  "johannesburg-za": "FAJS", "cape-town-za": "FACT", "durban-za": "FALE",
  "port-elizabeth-za": "FAPE", "lusaka-zm": "FLKK", "livingstone-zm": "FLLI",
  "ndola-zm": "FLND", "gaborone-bw": "FBSK", "maun-bw": "FBMN",
  "francistown-bw": "FBFT", "windhoek-na": "FYWH", "walvis-bay-na": "FYWB",
  "lilongwe-mw": "FWKI", "blantyre-mw": "FWCL", "maputo-mz": "FQMA",
  "beira-mz": "FQBR", "nampula-mz": "FQNP", "luanda-ao": "FNLU",
  "manzini-sz": "FDSK", "mbabane-sz": "FDSK", "maseru-ls": "FXMM",
  // Rest of Africa
  "nairobi-ke": "HKJK", "lagos-ng": "DNMM", "cairo-eg": "HECA",
  "dar-es-salaam-tz": "HTDA", "addis-ababa-et": "HAAB", "accra-gh": "DGAA",
  "kampala-ug": "HUEN", "kigali-rw": "HRYR", "dakar-sn": "GOBD",
  "abidjan-ci": "DIAP", "douala-cm": "FKKD", "antananarivo-mg": "FMMI",
  "mauritius-mu": "FIMP",
  // ASEAN / South Asia
  "bangkok-th": "VTBS", "singapore-sg": "WSSS", "kuala-lumpur-my": "WMKK",
  "jakarta-id": "WIII", "manila-ph": "RPLL", "dhaka-bd": "VGHS",
  "colombo-lk": "VCBI",
};

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Returns the ICAO airport code for a location slug, or null if not mapped. */
export function getIcaoForSlug(slug: string): string | null {
  return ICAO_MAP[slug] ?? null;
}

/**
 * Returns the N nearest airports (sorted closest-first) within maxDistanceKm.
 * Use this to offer the user a choice of nearby METAR/TAF stations.
 */
export function getNearestIcaos(
  lat: number,
  lon: number,
  count = 5,
  maxDistanceKm = 500,
): AirportDistance[] {
  return AIRPORTS
    .map((a) => ({ icao: a.icao, name: a.name, distanceKm: haversineKm(lat, lon, a.lat, a.lon) }))
    .filter((a) => a.distanceKm <= maxDistanceKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, count);
}

/**
 * Returns the nearest ICAO code within maxDistanceKm (default 150km).
 * Use this as a fallback when getIcaoForSlug returns null.
 */
export function getNearestIcao(lat: number, lon: number, maxDistanceKm = 150): string | null {
  const [nearest] = getNearestIcaos(lat, lon, 1, maxDistanceKm);
  return nearest?.icao ?? null;
}

/** Returns airport metadata (name + coords) for an ICAO code, or null. */
export function getAirportByIcao(icao: string): { icao: string; name: string; lat: number; lon: number } | null {
  return AIRPORT_BY_ICAO[icao.toUpperCase()] ?? null;
}

/** Returns the location slug for an ICAO code, or null if not mapped. */
export function getSlugForIcao(icao: string): string | null {
  const upper = icao.toUpperCase();
  const entry = Object.entries(ICAO_MAP).find(([, code]) => code === upper);
  return entry ? entry[0] : null;
}

export { ICAO_MAP };
