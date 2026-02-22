/** Activity definitions for personalized weather insights — extends the LocationTag system */

import type { LocationTag } from "./locations";

export type ActivityCategory = LocationTag | "sports" | "casual";

export interface Activity {
  id: string;
  label: string;
  category: ActivityCategory;
  /** Which location tags this activity is relevant to (for AI cross-referencing) */
  relevantTags: LocationTag[];
  description: string;
  /** Icon identifier for data-driven icon lookup (e.g. "crop", "drone", "tennis") */
  icon?: string;
}

export interface ActivityCategoryInfo {
  id: ActivityCategory;
  label: string;
}

/** Categories extend LocationTag with user-activity categories (sports, casual) */
export const ACTIVITY_CATEGORIES: ActivityCategoryInfo[] = [
  { id: "farming", label: "Farming" },
  { id: "mining", label: "Mining" },
  { id: "travel", label: "Travel" },
  { id: "tourism", label: "Tourism" },
  { id: "sports", label: "Sports" },
  { id: "casual", label: "Casual" },
];

/** Category → mineral color CSS classes (all static for Tailwind JIT) */
export interface CategoryStyle {
  bg: string;
  border: string;
  text: string;
  badge: string;
}

export const CATEGORY_STYLES: Record<string, CategoryStyle> = {
  farming:  { bg: "bg-mineral-malachite/10",  border: "border-mineral-malachite",  text: "text-mineral-malachite",  badge: "bg-mineral-malachite text-mineral-malachite-fg" },
  mining:   { bg: "bg-mineral-terracotta/10",  border: "border-mineral-terracotta",  text: "text-mineral-terracotta",  badge: "bg-mineral-terracotta text-mineral-terracotta-fg" },
  travel:   { bg: "bg-mineral-cobalt/10",      border: "border-mineral-cobalt",      text: "text-mineral-cobalt",      badge: "bg-mineral-cobalt text-mineral-cobalt-fg" },
  tourism:  { bg: "bg-mineral-tanzanite/10",   border: "border-mineral-tanzanite",   text: "text-mineral-tanzanite",   badge: "bg-mineral-tanzanite text-mineral-tanzanite-fg" },
  sports:   { bg: "bg-mineral-gold/10",        border: "border-mineral-gold",        text: "text-mineral-gold",        badge: "bg-mineral-gold text-mineral-gold-fg" },
  casual:   { bg: "bg-primary/10",             border: "border-primary",             text: "text-primary",             badge: "bg-primary text-primary-foreground" },
};

export const ACTIVITIES: Activity[] = [
  // Farming — maps to "farming" location tag
  { id: "crop-farming", label: "Crop Farming", category: "farming", relevantTags: ["farming"], description: "Maize, tobacco, cotton, and other crop cultivation", icon: "crop" },
  { id: "livestock", label: "Livestock", category: "farming", relevantTags: ["farming"], description: "Cattle ranching and animal husbandry", icon: "livestock" },
  { id: "gardening", label: "Gardening", category: "farming", relevantTags: ["farming"], description: "Home gardens and small-scale horticulture", icon: "shovel" },
  { id: "irrigation", label: "Irrigation", category: "farming", relevantTags: ["farming"], description: "Irrigation scheduling and water management", icon: "water" },

  // Mining — maps to "mining" location tag
  { id: "mining", label: "Mining", category: "mining", relevantTags: ["mining"], description: "Mining operations and outdoor extraction", icon: "pickaxe" },
  { id: "construction", label: "Construction", category: "mining", relevantTags: ["mining", "city"], description: "Building and construction work", icon: "hardhat" },

  // Travel — maps to "travel" and "border" location tags
  { id: "driving", label: "Driving", category: "travel", relevantTags: ["travel", "border"], description: "Road trips and long-distance driving", icon: "car" },
  { id: "commuting", label: "Commuting", category: "travel", relevantTags: ["travel", "city"], description: "Daily commute to work or school", icon: "bus" },
  { id: "flying", label: "Flying", category: "travel", relevantTags: ["travel", "city"], description: "Air travel and flight planning", icon: "plane" },

  // Tourism — maps to "tourism" and "national-park" location tags
  { id: "safari", label: "Safari", category: "tourism", relevantTags: ["tourism", "national-park"], description: "Game drives and wildlife viewing", icon: "binoculars" },
  { id: "photography", label: "Photography", category: "tourism", relevantTags: ["tourism", "national-park"], description: "Outdoor and landscape photography", icon: "camera" },
  { id: "birdwatching", label: "Birdwatching", category: "tourism", relevantTags: ["tourism", "national-park"], description: "Birding and wildlife observation", icon: "bird" },
  { id: "camping", label: "Camping", category: "tourism", relevantTags: ["tourism", "national-park"], description: "Outdoor camping and overnight stays", icon: "tent" },
  { id: "stargazing", label: "Stargazing", category: "tourism", relevantTags: ["tourism", "national-park"], description: "Night sky observation and astronomy", icon: "star" },
  { id: "fishing", label: "Fishing", category: "tourism", relevantTags: ["tourism", "national-park"], description: "Lake and river fishing excursions", icon: "fish" },

  // Sports — new user-activity category (not a location tag)
  { id: "running", label: "Running", category: "sports", relevantTags: ["city"], description: "Outdoor running and jogging", icon: "running" },
  { id: "cycling", label: "Cycling", category: "sports", relevantTags: ["city", "travel"], description: "Road and trail cycling", icon: "bicycle" },
  { id: "hiking", label: "Hiking", category: "sports", relevantTags: ["tourism", "national-park"], description: "Trail hiking and mountain walks", icon: "mountain" },
  { id: "football", label: "Football", category: "sports", relevantTags: ["city", "education"], description: "Football and soccer training or matches", icon: "football" },
  { id: "swimming", label: "Swimming", category: "sports", relevantTags: ["tourism", "city"], description: "Outdoor swimming", icon: "swimming" },
  { id: "golf", label: "Golf", category: "sports", relevantTags: ["tourism", "city"], description: "Golf rounds and practice", icon: "golf" },
  { id: "cricket", label: "Cricket", category: "sports", relevantTags: ["city", "education"], description: "Cricket training and matches", icon: "cricket" },
  { id: "tennis", label: "Tennis", category: "sports", relevantTags: ["city", "education"], description: "Tennis matches and practice", icon: "tennis" },
  { id: "rugby", label: "Rugby", category: "sports", relevantTags: ["city", "education"], description: "Rugby training and matches", icon: "rugby" },
  { id: "horse-riding", label: "Horse Riding", category: "sports", relevantTags: ["tourism", "farming"], description: "Equestrian riding and trail rides", icon: "horse" },

  // Casual — new user-activity category (not a location tag)
  { id: "walking", label: "Walking", category: "casual", relevantTags: ["city"], description: "Leisure walks and strolling", icon: "footprints" },
  { id: "barbecue", label: "Barbecue", category: "casual", relevantTags: [], description: "Braai and outdoor cooking", icon: "grill" },
  { id: "outdoor-events", label: "Outdoor Events", category: "casual", relevantTags: ["city", "tourism"], description: "Markets, festivals, and outdoor gatherings", icon: "sparkles" },
  { id: "drone-flying", label: "Drone Flying", category: "casual", relevantTags: ["city", "tourism", "farming"], description: "Recreational and commercial drone operations", icon: "drone" },
  { id: "picnic", label: "Picnic", category: "casual", relevantTags: ["city", "tourism"], description: "Outdoor picnics and lunch in the park", icon: "picnic" },
];

export function getActivitiesByCategory(category: ActivityCategory): Activity[] {
  return ACTIVITIES.filter((a) => a.category === category);
}

export function getActivityById(id: string): Activity | undefined {
  return ACTIVITIES.find((a) => a.id === id);
}

export function getActivityLabels(ids: string[]): string[] {
  return ids
    .map((id) => ACTIVITIES.find((a) => a.id === id)?.label)
    .filter((label): label is string => label !== undefined);
}

/** Get selected activities that are relevant to the given location tags */
export function getRelevantActivities(locationTags: string[], selectedIds: string[]): Activity[] {
  return ACTIVITIES.filter(
    (a) =>
      selectedIds.includes(a.id) &&
      (a.relevantTags.length === 0 || a.relevantTags.some((t) => locationTags.includes(t))),
  );
}

export function searchActivities(query: string): Activity[] {
  const q = query.toLowerCase().trim();
  if (!q) return ACTIVITIES;
  return ACTIVITIES.filter(
    (a) =>
      a.label.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q) ||
      a.category.includes(q),
  );
}
