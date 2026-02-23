/** Activity definitions for personalized weather insights — extends the LocationTag system */

import type { LocationTag } from "./locations";

/** Activity categories — includes location tags plus sports/casual */
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

/**
 * Categories extend LocationTag with user-activity categories (sports, casual).
 * Labels are broadened to reflect the full scope of African industries and lifestyles.
 * The category IDs remain unchanged (farming/mining/travel/tourism/sports/casual)
 * for backward compatibility with suitability rules, seed data, and location tags.
 */
export const ACTIVITY_CATEGORIES: ActivityCategoryInfo[] = [
  { id: "farming", label: "Agriculture & Forestry" },
  { id: "mining", label: "Industry & Construction" },
  { id: "travel", label: "Transport & Logistics" },
  { id: "tourism", label: "Outdoors & Conservation" },
  { id: "sports", label: "Sports & Fitness" },
  { id: "casual", label: "Lifestyle & Events" },
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
  // ── Agriculture & Forestry (category: "farming") ──────────────────────
  { id: "crop-farming", label: "Crop Farming", category: "farming", relevantTags: ["farming"], description: "Maize, tobacco, cotton, soya, and other crop cultivation", icon: "crop" },
  { id: "livestock", label: "Livestock", category: "farming", relevantTags: ["farming"], description: "Cattle ranching, poultry, and animal husbandry", icon: "livestock" },
  { id: "horticulture", label: "Horticulture", category: "farming", relevantTags: ["farming"], description: "Vegetables, fruit orchards, and commercial growing", icon: "leaf" },
  { id: "gardening", label: "Gardening", category: "farming", relevantTags: ["farming"], description: "Home gardens and small-scale growing", icon: "shovel" },
  { id: "irrigation", label: "Irrigation", category: "farming", relevantTags: ["farming"], description: "Irrigation scheduling and water management", icon: "water" },
  { id: "forestry", label: "Forestry", category: "farming", relevantTags: ["farming", "national-park"], description: "Timber, plantations, and forest management", icon: "tree" },
  { id: "beekeeping", label: "Beekeeping", category: "farming", relevantTags: ["farming"], description: "Apiary management and honey production", icon: "bee" },
  { id: "aquaculture", label: "Aquaculture", category: "farming", relevantTags: ["farming"], description: "Fish farming, tilapia ponds, and shrimp culture", icon: "fish" },

  // ── Industry & Construction (category: "mining") ─────────────────────
  { id: "mining", label: "Mining", category: "mining", relevantTags: ["mining"], description: "Mining operations and outdoor extraction", icon: "pickaxe" },
  { id: "construction", label: "Construction", category: "mining", relevantTags: ["mining", "city"], description: "Building and construction work", icon: "hardhat" },
  { id: "manufacturing", label: "Manufacturing", category: "mining", relevantTags: ["city"], description: "Factory operations, warehousing, and shift work", icon: "factory" },
  { id: "energy", label: "Energy & Utilities", category: "mining", relevantTags: ["mining", "city"], description: "Solar, hydro, and power line maintenance", icon: "bolt" },
  { id: "logistics", label: "Warehousing", category: "mining", relevantTags: ["city"], description: "Loading docks, cold chain, and inventory management", icon: "box" },

  // ── Transport & Logistics (category: "travel") ───────────────────────
  { id: "driving", label: "Driving", category: "travel", relevantTags: ["travel", "border"], description: "Road trips and long-distance driving", icon: "car" },
  { id: "commuting", label: "Commuting", category: "travel", relevantTags: ["travel", "city"], description: "Daily commute to work or school", icon: "bus" },
  { id: "flying", label: "Flying", category: "travel", relevantTags: ["travel", "city"], description: "Air travel and flight planning", icon: "plane" },
  { id: "trucking", label: "Trucking", category: "travel", relevantTags: ["travel", "border"], description: "Long-haul freight and cross-border transport", icon: "truck" },
  { id: "shipping", label: "Marine & Shipping", category: "travel", relevantTags: ["travel", "border"], description: "Port operations, fishing vessels, and marine transport", icon: "ship" },

  // ── Outdoors & Conservation (category: "tourism") ────────────────────
  { id: "safari", label: "Safari", category: "tourism", relevantTags: ["tourism", "national-park"], description: "Game drives and wildlife viewing", icon: "binoculars" },
  { id: "photography", label: "Photography", category: "tourism", relevantTags: ["tourism", "national-park"], description: "Outdoor and landscape photography", icon: "camera" },
  { id: "birdwatching", label: "Birdwatching", category: "tourism", relevantTags: ["tourism", "national-park"], description: "Birding and wildlife observation", icon: "bird" },
  { id: "camping", label: "Camping", category: "tourism", relevantTags: ["tourism", "national-park"], description: "Outdoor camping and overnight stays", icon: "tent" },
  { id: "stargazing", label: "Stargazing", category: "tourism", relevantTags: ["tourism", "national-park"], description: "Night sky observation and astronomy", icon: "star" },
  { id: "fishing", label: "Fishing", category: "tourism", relevantTags: ["tourism", "national-park"], description: "Lake and river fishing excursions", icon: "anchor" },
  { id: "conservation", label: "Conservation", category: "tourism", relevantTags: ["national-park", "tourism"], description: "Park rangers, anti-poaching patrols, and wildlife management", icon: "shield" },
  { id: "wildlife-research", label: "Wildlife Research", category: "tourism", relevantTags: ["national-park", "tourism"], description: "Field research, animal tracking, and ecological monitoring", icon: "pawprint" },
  { id: "hiking", label: "Hiking", category: "tourism", relevantTags: ["tourism", "national-park"], description: "Trail hiking and mountain walks", icon: "mountain" },

  // ── Sports & Fitness (category: "sports") ────────────────────────────
  { id: "running", label: "Running", category: "sports", relevantTags: ["city"], description: "Outdoor running, jogging, and marathons", icon: "running" },
  { id: "cycling", label: "Cycling", category: "sports", relevantTags: ["city", "travel"], description: "Road and trail cycling, competitive or recreational", icon: "bicycle" },
  { id: "football", label: "Football", category: "sports", relevantTags: ["city", "education"], description: "Football training, matches, and tournaments", icon: "football" },
  { id: "swimming", label: "Swimming", category: "sports", relevantTags: ["tourism", "city"], description: "Outdoor swimming, water polo, and aquatics", icon: "swimming" },
  { id: "golf", label: "Golf", category: "sports", relevantTags: ["tourism", "city"], description: "Golf rounds and practice", icon: "golf" },
  { id: "cricket", label: "Cricket", category: "sports", relevantTags: ["city", "education"], description: "Cricket training and matches", icon: "cricket" },
  { id: "tennis", label: "Tennis", category: "sports", relevantTags: ["city", "education"], description: "Tennis matches and practice", icon: "tennis" },
  { id: "rugby", label: "Rugby", category: "sports", relevantTags: ["city", "education"], description: "Rugby training and matches", icon: "rugby" },
  { id: "horse-riding", label: "Horse Riding", category: "sports", relevantTags: ["tourism", "farming"], description: "Equestrian riding, polo, and trail rides", icon: "horse" },
  { id: "athletics", label: "Athletics", category: "sports", relevantTags: ["city", "education"], description: "Track and field, professional and school level", icon: "trophy" },
  { id: "coaching", label: "Coaching & Training", category: "sports", relevantTags: ["city", "education"], description: "Outdoor sports coaching, drills, and fitness programs", icon: "whistle" },

  // ── Lifestyle & Events (category: "casual") ─────────────────────────
  { id: "walking", label: "Walking", category: "casual", relevantTags: ["city"], description: "Leisure walks and strolling", icon: "footprints" },
  { id: "barbecue", label: "Barbecue", category: "casual", relevantTags: [], description: "Braai and outdoor cooking", icon: "grill" },
  { id: "outdoor-events", label: "Outdoor Events", category: "casual", relevantTags: ["city", "tourism"], description: "Markets, exhibitions, and outdoor gatherings", icon: "sparkles" },
  { id: "festivals", label: "Festivals & Concerts", category: "casual", relevantTags: ["city", "tourism"], description: "Music festivals, cultural events, and live performances", icon: "music" },
  { id: "weddings", label: "Weddings & Ceremonies", category: "casual", relevantTags: ["city", "tourism"], description: "Outdoor weddings, receptions, and celebrations", icon: "calendar" },
  { id: "drone-flying", label: "Drone Flying", category: "casual", relevantTags: ["city", "tourism", "farming"], description: "Recreational and commercial drone operations", icon: "drone" },
  { id: "picnic", label: "Picnic", category: "casual", relevantTags: ["city", "tourism"], description: "Outdoor picnics and lunch in the park", icon: "picnic" },
  { id: "health-wellness", label: "Health & Wellness", category: "casual", relevantTags: ["city"], description: "Outdoor yoga, tai chi, and wellness activities", icon: "heartpulse" },
  { id: "education", label: "School & Education", category: "casual", relevantTags: ["city", "education"], description: "Outdoor school activities, athletics day, and field trips", icon: "graduationcap" },
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

/**
 * Get suggested default activities for a location based on its tags.
 * Returns the top activities whose relevantTags overlap with the location's tags,
 * plus universally relevant activities (empty relevantTags).
 * Used to pre-populate activity suggestions when a user visits a new location.
 */
export function getDefaultActivitiesForLocation(locationTags: string[], limit = 6): Activity[] {
  // Score activities by how many of their relevantTags match the location
  const scored = ACTIVITIES.map((a) => {
    if (a.relevantTags.length === 0) return { activity: a, score: 0.5 }; // universal, lower priority
    const matchCount = a.relevantTags.filter((t) => locationTags.includes(t)).length;
    return { activity: a, score: matchCount / a.relevantTags.length };
  }).filter((s) => s.score > 0);

  // Sort by score descending, then alphabetically for ties
  scored.sort((a, b) => b.score - a.score || a.activity.label.localeCompare(b.activity.label));

  return scored.slice(0, limit).map((s) => s.activity);
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
