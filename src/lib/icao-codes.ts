/**
 * Maps location slugs to ICAO airport codes.
 * Also provides nearest-airport lookup by lat/lon for locations
 * not in the slug map (community-created GPS locations, etc.).
 */

interface Airport {
  icao: string;
  lat: number;
  lon: number;
}

/** ICAO airports with approximate coordinates for distance lookup */
const AIRPORTS: Airport[] = [
  // Zimbabwe
  { icao: "FVHA", lat: -17.932, lon: 31.093 }, // Harare International
  { icao: "FVBU", lat: -20.017, lon: 28.618 }, // Bulawayo J.M. Nkomo
  { icao: "FVFA", lat: -18.096, lon: 25.839 }, // Victoria Falls
  { icao: "FVMV", lat: -20.055, lon: 30.859 }, // Masvingo
  { icao: "FVGW", lat: -19.436, lon: 29.861 }, // Gweru Thornhill
  { icao: "FVMU", lat: -18.998, lon: 32.627 }, // Mutare
  { icao: "FVKB", lat: -16.520, lon: 28.885 }, // Kariba
  { icao: "FVWN", lat: -18.629, lon: 27.021 }, // Hwange National Park
  { icao: "FVKK", lat: -18.929, lon: 29.738 }, // Kwekwe
  { icao: "FVBB", lat: -22.200, lon: 29.433 }, // Beitbridge
  { icao: "FVBD", lat: -17.175, lon: 31.331 }, // Bindura
  { icao: "FVCH", lat: -17.352, lon: 30.324 }, // Chinhoyi
  { icao: "FVBR", lat: -21.001, lon: 31.579 }, // Buffalo Range

  // Africa
  { icao: "HKJK", lat: -1.319, lon: 36.928 },  // Nairobi Jomo Kenyatta
  { icao: "DNMM", lat: 6.577, lon: 3.321 },    // Lagos Murtala Muhammed
  { icao: "HECA", lat: 30.122, lon: 31.406 },  // Cairo International
  { icao: "FAJS", lat: -26.134, lon: 28.242 }, // Johannesburg O.R. Tambo
  { icao: "FACT", lat: -33.965, lon: 18.602 }, // Cape Town
  { icao: "HTDA", lat: -6.878, lon: 39.203 },  // Dar es Salaam Julius Nyerere
  { icao: "HAAB", lat: 8.978, lon: 38.799 },   // Addis Ababa Bole
  { icao: "DGAA", lat: 5.605, lon: -0.167 },   // Accra Kotoka
  { icao: "HUEN", lat: 0.042, lon: 32.443 },   // Kampala Entebbe
  { icao: "FLLS", lat: -15.330, lon: 28.452 }, // Lusaka Kenneth Kaunda
  { icao: "FQMA", lat: -25.921, lon: 32.573 }, // Maputo International
  { icao: "HRYR", lat: -1.968, lon: 30.139 },  // Kigali International
  { icao: "GOOY", lat: 14.740, lon: -17.491 }, // Dakar Blaise Diagne
  { icao: "DIAP", lat: 5.261, lon: -3.926 },   // Abidjan Felix Houphouet-Boigny
  { icao: "FKKD", lat: 4.007, lon: 9.719 },    // Douala International
  { icao: "FMMI", lat: -18.797, lon: 47.479 }, // Antananarivo Ivato
  { icao: "FIMP", lat: -20.430, lon: 57.683 }, // Mauritius Sir Seewoosagur Ramgoolam

  // ASEAN
  { icao: "VTBS", lat: 13.681, lon: 100.747 }, // Bangkok Suvarnabhumi
  { icao: "WSSS", lat: 1.350, lon: 103.994 },  // Singapore Changi
  { icao: "WMKK", lat: 2.746, lon: 101.710 },  // Kuala Lumpur International
  { icao: "WIII", lat: -6.126, lon: 106.656 }, // Jakarta Soekarno-Hatta
  { icao: "RPLL", lat: 14.508, lon: 121.020 }, // Manila Ninoy Aquino
  { icao: "VGHS", lat: 23.843, lon: 90.398 },  // Dhaka Hazrat Shahjalal
  { icao: "VCBI", lat: 7.181, lon: 79.885 },   // Colombo Bandaranaike
];

/** Slug→ICAO for seed locations (fast O(1) lookup) */
const ICAO_MAP: Record<string, string> = {
  harare: "FVHA", bulawayo: "FVBU", "victoria-falls": "FVFA",
  masvingo: "FVMV", gweru: "FVGW", mutare: "FVMU", kariba: "FVKB",
  "hwange-national-park": "FVWN", kwekwe: "FVKK", beitbridge: "FVBB",
  bindura: "FVBD", chinhoyi: "FVCH", "buffalo-range": "FVBR",
  "nairobi-ke": "HKJK", "lagos-ng": "DNMM", "cairo-eg": "HECA",
  "johannesburg-za": "FAJS", "cape-town-za": "FACT", "dar-es-salaam-tz": "HTDA",
  "addis-ababa-et": "HAAB", "accra-gh": "DGAA", "kampala-ug": "HUEN",
  "lusaka-zm": "FLLS", "maputo-mz": "FQMA", "kigali-rw": "HRYR",
  "dakar-sn": "GOOY", "abidjan-ci": "DIAP", "douala-cm": "FKKD",
  "antananarivo-mg": "FMMI", "mauritius-mu": "FIMP",
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
 * Returns the nearest ICAO code within maxDistanceKm (default 150km).
 * Use this as a fallback when getIcaoForSlug returns null.
 */
export function getNearestIcao(lat: number, lon: number, maxDistanceKm = 150): string | null {
  let nearest: { icao: string; distKm: number } | null = null;
  for (const airport of AIRPORTS) {
    const distKm = haversineKm(lat, lon, airport.lat, airport.lon);
    if (distKm <= maxDistanceKm && (!nearest || distKm < nearest.distKm)) {
      nearest = { icao: airport.icao, distKm };
    }
  }
  return nearest?.icao ?? null;
}

/** Returns the location slug for an ICAO code, or null if not mapped. */
export function getSlugForIcao(icao: string): string | null {
  const upper = icao.toUpperCase();
  const entry = Object.entries(ICAO_MAP).find(([, code]) => code === upper);
  return entry ? entry[0] : null;
}

export { ICAO_MAP };
