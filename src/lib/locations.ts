import { AFRICA_LOCATIONS } from "./locations-africa";

export interface WeatherLocation {
  slug: string;
  name: string;
  /** Province, state, region, or administrative division */
  province: string;
  lat: number;
  lon: number;
  elevation: number;
  tags: string[];
  /** ISO 3166-1 alpha-2 country code (defaults to "ZW") */
  country?: string;
  /** How this location was added */
  source?: "seed" | "community" | "geolocation";
  /** Links location to the provinces collection — auto-computed if absent */
  provinceSlug?: string;
}

/** @deprecated Use WeatherLocation instead */
export type ZimbabweLocation = WeatherLocation;

/**
 * Location tag — any string slug from the database `tags` collection.
 * New tags can be added via db-init without code changes.
 */
export type LocationTag = string;


export const ZW_LOCATIONS: ZimbabweLocation[] = [
  // ===== CITIES & TOWNS =====
  { slug: "harare", name: "Harare", province: "Harare", lat: -17.83, lon: 31.05, elevation: 1490, tags: ["city", "education"] },
  { slug: "bulawayo", name: "Bulawayo", province: "Bulawayo", lat: -20.15, lon: 28.58, elevation: 1348, tags: ["city", "education"] },
  { slug: "mutare", name: "Mutare", province: "Manicaland", lat: -18.97, lon: 32.67, elevation: 1073, tags: ["city", "education"] },
  { slug: "gweru", name: "Gweru", province: "Midlands", lat: -19.45, lon: 29.82, elevation: 1422, tags: ["city", "education"] },
  { slug: "masvingo", name: "Masvingo", province: "Masvingo", lat: -20.07, lon: 30.83, elevation: 1095, tags: ["city", "education", "tourism"] },
  { slug: "kwekwe", name: "Kwekwe", province: "Midlands", lat: -18.93, lon: 29.82, elevation: 1214, tags: ["city", "mining"] },
  { slug: "kadoma", name: "Kadoma", province: "Mashonaland West", lat: -18.35, lon: 29.92, elevation: 1152, tags: ["city", "mining"] },
  { slug: "marondera", name: "Marondera", province: "Mashonaland East", lat: -18.19, lon: 31.55, elevation: 1634, tags: ["city", "farming", "education"] },
  { slug: "chinhoyi", name: "Chinhoyi", province: "Mashonaland West", lat: -17.37, lon: 30.20, elevation: 1143, tags: ["city", "tourism"] },
  { slug: "victoria-falls", name: "Victoria Falls", province: "Matabeleland North", lat: -17.93, lon: 25.85, elevation: 915, tags: ["city", "tourism", "travel", "border"] },
  { slug: "chitungwiza", name: "Chitungwiza", province: "Harare", lat: -17.99, lon: 31.08, elevation: 1463, tags: ["city"] },
  { slug: "bindura", name: "Bindura", province: "Mashonaland Central", lat: -17.30, lon: 31.33, elevation: 1112, tags: ["city", "mining", "education"] },
  { slug: "zvishavane", name: "Zvishavane", province: "Midlands", lat: -20.33, lon: 30.07, elevation: 914, tags: ["city", "mining"] },
  { slug: "kariba", name: "Kariba", province: "Mashonaland West", lat: -16.52, lon: 28.80, elevation: 519, tags: ["city", "tourism"] },
  { slug: "hwange", name: "Hwange", province: "Matabeleland North", lat: -18.37, lon: 26.50, elevation: 900, tags: ["city", "mining", "tourism"] },
  { slug: "chiredzi", name: "Chiredzi", province: "Masvingo", lat: -21.05, lon: 31.67, elevation: 430, tags: ["city", "farming"] },
  { slug: "chipinge", name: "Chipinge", province: "Manicaland", lat: -20.19, lon: 32.63, elevation: 1132, tags: ["city", "farming"] },
  { slug: "rusape", name: "Rusape", province: "Manicaland", lat: -18.53, lon: 32.13, elevation: 1430, tags: ["city", "farming"] },
  { slug: "beitbridge", name: "Beitbridge", province: "Matabeleland South", lat: -22.22, lon: 30.00, elevation: 457, tags: ["city", "border", "travel"] },
  { slug: "plumtree", name: "Plumtree", province: "Matabeleland South", lat: -20.48, lon: 27.82, elevation: 1362, tags: ["city", "border"] },
  { slug: "norton", name: "Norton", province: "Mashonaland West", lat: -17.88, lon: 30.70, elevation: 1364, tags: ["city"] },
  { slug: "ruwa", name: "Ruwa", province: "Mashonaland East", lat: -17.89, lon: 31.25, elevation: 1473, tags: ["city"] },
  { slug: "epworth", name: "Epworth", province: "Harare", lat: -17.89, lon: 31.15, elevation: 1490, tags: ["city"] },
  { slug: "redcliff", name: "Redcliff", province: "Midlands", lat: -19.03, lon: 29.78, elevation: 1220, tags: ["city", "mining"] },
  { slug: "shurugwi", name: "Shurugwi", province: "Midlands", lat: -19.67, lon: 29.99, elevation: 1300, tags: ["city", "mining"] },
  { slug: "chegutu", name: "Chegutu", province: "Mashonaland West", lat: -18.13, lon: 30.15, elevation: 1140, tags: ["city", "farming"] },

  // ===== FARMING REGIONS =====
  { slug: "mazowe", name: "Mazowe", province: "Mashonaland Central", lat: -17.52, lon: 30.97, elevation: 1219, tags: ["farming"] },
  { slug: "shamva", name: "Shamva", province: "Mashonaland Central", lat: -17.31, lon: 31.57, elevation: 1060, tags: ["farming", "mining"] },
  { slug: "concession", name: "Concession", province: "Mashonaland Central", lat: -17.38, lon: 30.95, elevation: 1280, tags: ["farming"] },
  { slug: "headlands", name: "Headlands", province: "Manicaland", lat: -18.28, lon: 32.05, elevation: 1470, tags: ["farming"] },
  { slug: "odzi", name: "Odzi", province: "Manicaland", lat: -18.97, lon: 32.37, elevation: 960, tags: ["farming"] },
  { slug: "penhalonga", name: "Penhalonga", province: "Manicaland", lat: -18.90, lon: 32.70, elevation: 1010, tags: ["farming", "mining"] },
  { slug: "nyanga", name: "Nyanga", province: "Manicaland", lat: -18.22, lon: 32.75, elevation: 1850, tags: ["farming", "tourism"] },
  { slug: "chimanimani", name: "Chimanimani", province: "Manicaland", lat: -19.80, lon: 32.87, elevation: 1650, tags: ["farming", "tourism", "national-park"] },
  { slug: "triangle", name: "Triangle", province: "Masvingo", lat: -21.02, lon: 31.51, elevation: 450, tags: ["farming"] },
  { slug: "hippo-valley", name: "Hippo Valley", province: "Masvingo", lat: -21.08, lon: 31.60, elevation: 420, tags: ["farming"] },
  { slug: "selous", name: "Selous", province: "Mashonaland West", lat: -18.00, lon: 30.42, elevation: 1100, tags: ["farming"] },
  { slug: "mvurwi", name: "Mvurwi", province: "Mashonaland Central", lat: -17.04, lon: 30.85, elevation: 1230, tags: ["farming"] },
  { slug: "glendale", name: "Glendale", province: "Mashonaland Central", lat: -17.36, lon: 31.08, elevation: 1250, tags: ["farming"] },
  { slug: "centenary", name: "Centenary", province: "Mashonaland Central", lat: -16.73, lon: 31.12, elevation: 910, tags: ["farming"] },
  { slug: "banket", name: "Banket", province: "Mashonaland West", lat: -17.38, lon: 30.40, elevation: 1100, tags: ["farming"] },
  { slug: "karoi", name: "Karoi", province: "Mashonaland West", lat: -16.81, lon: 29.69, elevation: 1300, tags: ["farming", "travel"] },
  { slug: "guruve", name: "Guruve", province: "Mashonaland Central", lat: -16.67, lon: 30.70, elevation: 1050, tags: ["farming"] },
  { slug: "muzarabani", name: "Muzarabani", province: "Mashonaland Central", lat: -16.33, lon: 31.10, elevation: 340, tags: ["farming"] },
  { slug: "mount-darwin", name: "Mount Darwin", province: "Mashonaland Central", lat: -16.77, lon: 31.58, elevation: 900, tags: ["farming"] },
  { slug: "lupane", name: "Lupane", province: "Matabeleland North", lat: -18.93, lon: 27.80, elevation: 1050, tags: ["farming"] },
  { slug: "gokwe", name: "Gokwe", province: "Midlands", lat: -18.22, lon: 28.93, elevation: 1280, tags: ["farming"] },
  { slug: "nkayi", name: "Nkayi", province: "Matabeleland North", lat: -19.00, lon: 28.90, elevation: 1050, tags: ["farming"] },
  { slug: "gutu", name: "Gutu", province: "Masvingo", lat: -19.93, lon: 31.00, elevation: 1200, tags: ["farming"] },
  { slug: "zaka", name: "Zaka", province: "Masvingo", lat: -20.33, lon: 31.47, elevation: 900, tags: ["farming"] },
  { slug: "bikita", name: "Bikita", province: "Masvingo", lat: -20.10, lon: 31.60, elevation: 1000, tags: ["farming", "mining"] },
  { slug: "mberengwa", name: "Mberengwa", province: "Midlands", lat: -20.42, lon: 29.98, elevation: 1200, tags: ["farming"] },

  // ===== MINING AREAS =====
  { slug: "hwange-colliery", name: "Hwange Colliery", province: "Matabeleland North", lat: -18.36, lon: 26.48, elevation: 880, tags: ["mining"] },
  { slug: "renco-mine", name: "Renco Mine", province: "Masvingo", lat: -20.49, lon: 31.53, elevation: 630, tags: ["mining"] },
  { slug: "bikita-minerals", name: "Bikita Minerals", province: "Masvingo", lat: -20.08, lon: 31.57, elevation: 1050, tags: ["mining"] },
  { slug: "kamativi", name: "Kamativi", province: "Matabeleland North", lat: -18.32, lon: 26.87, elevation: 970, tags: ["mining"] },
  { slug: "mutorashanga", name: "Mutorashanga", province: "Mashonaland West", lat: -17.30, lon: 30.38, elevation: 1400, tags: ["mining"] },
  { slug: "mashava", name: "Mashava", province: "Masvingo", lat: -20.05, lon: 30.47, elevation: 1200, tags: ["mining"] },
  { slug: "trojan-mine", name: "Trojan Mine", province: "Mashonaland Central", lat: -17.33, lon: 31.35, elevation: 1100, tags: ["mining"] },
  { slug: "mimosa-mine", name: "Mimosa Mine", province: "Midlands", lat: -20.35, lon: 30.10, elevation: 950, tags: ["mining"] },
  { slug: "unki-mine", name: "Unki Mine", province: "Midlands", lat: -19.68, lon: 30.05, elevation: 1300, tags: ["mining"] },
  { slug: "zimplats", name: "Zimplats (Ngezi)", province: "Mashonaland West", lat: -18.00, lon: 29.97, elevation: 1230, tags: ["mining"] },
  { slug: "murowa-diamond", name: "Murowa Diamond", province: "Midlands", lat: -20.02, lon: 30.10, elevation: 1100, tags: ["mining"] },
  { slug: "marange", name: "Marange", province: "Manicaland", lat: -19.40, lon: 32.55, elevation: 800, tags: ["mining"] },

  // ===== TOURISM & NATIONAL PARKS =====
  { slug: "matopos", name: "Matopos", province: "Matabeleland South", lat: -20.50, lon: 28.50, elevation: 1300, tags: ["tourism", "national-park"] },
  { slug: "great-zimbabwe", name: "Great Zimbabwe", province: "Masvingo", lat: -20.27, lon: 30.93, elevation: 1100, tags: ["tourism"] },
  { slug: "hwange-national-park", name: "Hwange National Park", province: "Matabeleland North", lat: -18.75, lon: 26.50, elevation: 1050, tags: ["tourism", "national-park"] },
  { slug: "mana-pools", name: "Mana Pools", province: "Mashonaland West", lat: -15.75, lon: 29.40, elevation: 350, tags: ["tourism", "national-park"] },
  { slug: "gonarezhou", name: "Gonarezhou", province: "Masvingo", lat: -21.75, lon: 31.75, elevation: 300, tags: ["tourism", "national-park"] },
  { slug: "lake-kariba", name: "Lake Kariba", province: "Mashonaland West", lat: -16.75, lon: 28.50, elevation: 485, tags: ["tourism"] },
  { slug: "nyanga-national-park", name: "Nyanga National Park", province: "Manicaland", lat: -18.30, lon: 32.75, elevation: 2000, tags: ["tourism", "national-park"] },
  { slug: "chimanimani-national-park", name: "Chimanimani National Park", province: "Manicaland", lat: -19.78, lon: 32.90, elevation: 1750, tags: ["tourism", "national-park"] },
  { slug: "matusadona", name: "Matusadona", province: "Mashonaland West", lat: -16.73, lon: 28.70, elevation: 490, tags: ["tourism", "national-park"] },
  { slug: "chizarira", name: "Chizarira", province: "Matabeleland North", lat: -17.77, lon: 27.90, elevation: 1300, tags: ["tourism", "national-park"] },
  { slug: "zambezi-national-park", name: "Zambezi National Park", province: "Matabeleland North", lat: -17.87, lon: 25.65, elevation: 910, tags: ["tourism", "national-park"] },

  // ===== EDUCATION CENTRES =====
  { slug: "zvimba", name: "Zvimba", province: "Mashonaland West", lat: -17.57, lon: 30.22, elevation: 1200, tags: ["education", "farming"] },
  { slug: "lower-gweru", name: "Lower Gweru", province: "Midlands", lat: -19.70, lon: 29.60, elevation: 1350, tags: ["education"] },
  { slug: "gokomere", name: "Gokomere", province: "Masvingo", lat: -20.18, lon: 30.68, elevation: 1050, tags: ["education"] },
  { slug: "kutama", name: "Kutama", province: "Mashonaland West", lat: -17.57, lon: 30.15, elevation: 1200, tags: ["education"] },
  { slug: "driefontein", name: "Driefontein", province: "Masvingo", lat: -19.80, lon: 30.80, elevation: 1100, tags: ["education"] },
  { slug: "dadaya", name: "Dadaya", province: "Midlands", lat: -20.22, lon: 29.75, elevation: 1200, tags: ["education"] },

  // ===== BORDER POSTS =====
  { slug: "chirundu", name: "Chirundu", province: "Mashonaland West", lat: -15.60, lon: 28.85, elevation: 370, tags: ["border", "travel"] },
  { slug: "forbes-border", name: "Forbes (Mutare)", province: "Manicaland", lat: -18.97, lon: 32.87, elevation: 900, tags: ["border", "travel"] },
  { slug: "nyamapanda", name: "Nyamapanda", province: "Mashonaland Central", lat: -16.28, lon: 32.30, elevation: 620, tags: ["border", "travel"] },
  { slug: "kazungula", name: "Kazungula", province: "Matabeleland North", lat: -17.78, lon: 25.27, elevation: 930, tags: ["border", "travel"] },
  { slug: "kanyemba", name: "Kanyemba", province: "Mashonaland Central", lat: -15.63, lon: 30.42, elevation: 340, tags: ["border"] },

  // ===== TRAVEL CORRIDORS — key waypoints along major routes =====
  { slug: "chivhu", name: "Chivhu", province: "Mashonaland East", lat: -19.02, lon: 30.90, elevation: 1430, tags: ["city", "travel"] },
  { slug: "mvuma", name: "Mvuma", province: "Midlands", lat: -19.28, lon: 30.53, elevation: 1350, tags: ["travel"] },
  { slug: "ngundu", name: "Ngundu", province: "Masvingo", lat: -21.03, lon: 30.97, elevation: 520, tags: ["travel"] },
  { slug: "west-nicholson", name: "West Nicholson", province: "Matabeleland South", lat: -21.05, lon: 29.37, elevation: 900, tags: ["travel"] },
  { slug: "gwanda", name: "Gwanda", province: "Matabeleland South", lat: -20.93, lon: 29.02, elevation: 940, tags: ["city", "travel", "mining"] },
  { slug: "filabusi", name: "Filabusi", province: "Matabeleland South", lat: -20.53, lon: 29.30, elevation: 1100, tags: ["travel", "mining"] },
  { slug: "mashingo-junction", name: "Skyline Junction", province: "Manicaland", lat: -18.80, lon: 32.45, elevation: 1500, tags: ["travel"] },
  { slug: "christmas-pass", name: "Christmas Pass", province: "Manicaland", lat: -18.95, lon: 32.60, elevation: 1200, tags: ["travel"] },
  { slug: "chinotimba", name: "Chinotimba", province: "Matabeleland North", lat: -17.95, lon: 25.83, elevation: 920, tags: ["travel"] },
  { slug: "makuti", name: "Makuti", province: "Mashonaland West", lat: -16.30, lon: 29.22, elevation: 600, tags: ["travel"] },
  { slug: "lion-den", name: "Lion's Den", province: "Mashonaland West", lat: -16.93, lon: 29.65, elevation: 1100, tags: ["travel"] },
];

/** Combined location array: Zimbabwe seed locations + African/ASEAN locations */
export const LOCATIONS: ZimbabweLocation[] = [...ZW_LOCATIONS, ...AFRICA_LOCATIONS];

