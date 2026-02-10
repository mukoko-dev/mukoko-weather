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

export const ACTIVITIES: Activity[] = [
  // Farming — maps to "farming" location tag
  { id: "crop-farming", label: "Crop Farming", category: "farming", relevantTags: ["farming"], description: "Maize, tobacco, cotton, and other crop cultivation" },
  { id: "livestock", label: "Livestock", category: "farming", relevantTags: ["farming"], description: "Cattle ranching and animal husbandry" },
  { id: "gardening", label: "Gardening", category: "farming", relevantTags: ["farming"], description: "Home gardens and small-scale horticulture" },

  // Mining — maps to "mining" location tag
  { id: "mining", label: "Mining", category: "mining", relevantTags: ["mining"], description: "Mining operations and outdoor extraction" },
  { id: "construction", label: "Construction", category: "mining", relevantTags: ["mining", "city"], description: "Building and construction work" },

  // Travel — maps to "travel" and "border" location tags
  { id: "driving", label: "Driving", category: "travel", relevantTags: ["travel", "border"], description: "Road trips and long-distance driving" },
  { id: "commuting", label: "Commuting", category: "travel", relevantTags: ["travel", "city"], description: "Daily commute to work or school" },

  // Tourism — maps to "tourism" and "national-park" location tags
  { id: "safari", label: "Safari", category: "tourism", relevantTags: ["tourism", "national-park"], description: "Game drives and wildlife viewing" },
  { id: "photography", label: "Photography", category: "tourism", relevantTags: ["tourism", "national-park"], description: "Outdoor and landscape photography" },
  { id: "birdwatching", label: "Birdwatching", category: "tourism", relevantTags: ["tourism", "national-park"], description: "Birding and wildlife observation" },

  // Sports — new user-activity category (not a location tag)
  { id: "running", label: "Running", category: "sports", relevantTags: ["city"], description: "Outdoor running and jogging" },
  { id: "cycling", label: "Cycling", category: "sports", relevantTags: ["city", "travel"], description: "Road and trail cycling" },
  { id: "hiking", label: "Hiking", category: "sports", relevantTags: ["tourism", "national-park"], description: "Trail hiking and mountain walks" },
  { id: "football", label: "Football", category: "sports", relevantTags: ["city", "education"], description: "Football and soccer training or matches" },
  { id: "swimming", label: "Swimming", category: "sports", relevantTags: ["tourism", "city"], description: "Outdoor swimming" },
  { id: "golf", label: "Golf", category: "sports", relevantTags: ["tourism", "city"], description: "Golf rounds and practice" },
  { id: "cricket", label: "Cricket", category: "sports", relevantTags: ["city", "education"], description: "Cricket training and matches" },

  // Casual — new user-activity category (not a location tag)
  { id: "walking", label: "Walking", category: "casual", relevantTags: ["city"], description: "Leisure walks and strolling" },
  { id: "barbecue", label: "Barbecue", category: "casual", relevantTags: [], description: "Braai and outdoor cooking" },
  { id: "outdoor-events", label: "Outdoor Events", category: "casual", relevantTags: ["city", "tourism"], description: "Markets, festivals, and outdoor gatherings" },
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
