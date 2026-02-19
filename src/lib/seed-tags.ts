/**
 * Seed data for the `tags` MongoDB collection.
 *
 * Read only by `POST /api/db-init` (one-time bootstrap) and tests.
 * At runtime, callers use getFeaturedTagsFromDb() / getTagBySlug() from db.ts.
 *
 * Consolidates: TAG_LABELS (locations.ts), TAG_META (explore/page.tsx),
 * VALID_TAGS (explore/[tag]/page.tsx).
 */

export interface TagDoc {
  slug: string;
  label: string;
  /** Short description shown on explore cards */
  description: string;
  /** Lucide icon name for explore card rendering */
  icon: string;
  /** Shown on /explore page */
  featured: boolean;
  /** Sort order for card display */
  order: number;
}

export const TAGS: TagDoc[] = [
  {
    slug: "city",
    label: "Cities & Towns",
    description: "Major urban centres across Zimbabwe",
    icon: "building",
    featured: true,
    order: 1,
  },
  {
    slug: "farming",
    label: "Farming Regions",
    description: "Agricultural areas — tobacco, sugar, cotton, citrus",
    icon: "sprout",
    featured: true,
    order: 2,
  },
  {
    slug: "mining",
    label: "Mining Areas",
    description: "Gold, platinum, diamond, lithium, and coal operations",
    icon: "pickaxe",
    featured: true,
    order: 3,
  },
  {
    slug: "tourism",
    label: "Tourism & Heritage",
    description: "National parks, UNESCO sites, natural wonders",
    icon: "camera",
    featured: true,
    order: 4,
  },
  {
    slug: "national-park",
    label: "National Parks",
    description: "Protected wildlife and wilderness areas",
    icon: "trees",
    featured: true,
    order: 5,
  },
  {
    slug: "education",
    label: "Education Centres",
    description: "University towns and mission schools",
    icon: "graduation-cap",
    featured: true,
    order: 6,
  },
  {
    slug: "border",
    label: "Border Posts",
    description: "International border crossings and ports of entry",
    icon: "flag",
    featured: true,
    order: 7,
  },
  {
    slug: "travel",
    label: "Travel Corridors",
    description: "Key transit routes and stopover points",
    icon: "route",
    featured: true,
    order: 8,
  },
];
