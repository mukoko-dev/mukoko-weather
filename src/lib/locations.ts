export interface ZimbabweLocation {
  slug: string;
  name: string;
  province: string;
  lat: number;
  lon: number;
  elevation: number;
  tags?: string[];
}

export const ZIMBABWE_BOUNDS = {
  north: -15.61,
  south: -22.42,
  east: 33.07,
  west: 25.24,
  center: { lat: -19.02, lon: 29.15 },
};

export const LOCATIONS: ZimbabweLocation[] = [
  { slug: "harare", name: "Harare", province: "Harare", lat: -17.83, lon: 31.05, elevation: 1490, tags: ["city"] },
  { slug: "bulawayo", name: "Bulawayo", province: "Bulawayo", lat: -20.15, lon: 28.58, elevation: 1348, tags: ["city"] },
  { slug: "mutare", name: "Mutare", province: "Manicaland", lat: -18.97, lon: 32.67, elevation: 1073, tags: ["city"] },
  { slug: "gweru", name: "Gweru", province: "Midlands", lat: -19.45, lon: 29.82, elevation: 1422, tags: ["city"] },
  { slug: "masvingo", name: "Masvingo", province: "Masvingo", lat: -20.07, lon: 30.83, elevation: 1095, tags: ["city"] },
  { slug: "kwekwe", name: "Kwekwe", province: "Midlands", lat: -18.93, lon: 29.82, elevation: 1214, tags: ["city"] },
  { slug: "kadoma", name: "Kadoma", province: "Mashonaland West", lat: -18.35, lon: 29.92, elevation: 1152, tags: ["city"] },
  { slug: "marondera", name: "Marondera", province: "Mashonaland East", lat: -18.19, lon: 31.55, elevation: 1634, tags: ["city", "farming"] },
  { slug: "chinhoyi", name: "Chinhoyi", province: "Mashonaland West", lat: -17.37, lon: 30.20, elevation: 1143, tags: ["city"] },
  { slug: "victoria-falls", name: "Victoria Falls", province: "Matabeleland North", lat: -17.93, lon: 25.85, elevation: 915, tags: ["city", "tourism"] },
];

export function getLocationBySlug(slug: string): ZimbabweLocation | undefined {
  return LOCATIONS.find((l) => l.slug === slug);
}
