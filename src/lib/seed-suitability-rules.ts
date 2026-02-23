/**
 * Seed suitability rules for database-driven weather suitability evaluation.
 *
 * Each rule set defines an ordered list of conditions evaluated against weather insight fields.
 * First matching condition wins. A fallback is provided for when no condition matches.
 *
 * Rule keys:
 * - "category:<category>" — applies to all activities in that category
 * - "activity:<id>" — applies to a specific activity (overrides category rule)
 *
 * Available weather insight fields:
 * - thunderstormProbability (0-100, %)
 * - heatStressIndex (0-50+)
 * - uvHealthConcern (0-11+)
 * - visibility (0-50+, km)
 * - dewPoint (-20 to 35+, °C)
 * - gdd10To30 (growing degree days)
 * - evapotranspiration (mm)
 * - precipitationType (0=none, 1=rain, 2=snow, 3=freezing rain, 4=ice pellets)
 * - moonPhase (0-7)
 */

import type { SuitabilityRuleDoc } from "./db";

type SeedRule = Omit<SuitabilityRuleDoc, "updatedAt">;

export const SUITABILITY_RULES: SeedRule[] = [
  // ── Category: Farming ───────────────────────────────────────────────────
  {
    key: "category:farming",
    // Condition order: most severe first. precipitationType >= 2 (freezing rain,
    // ice pellets) is the highest-severity farming hazard and must fire before
    // dew point checks — otherwise a fair dew point would mask severe precip.
    conditions: [
      {
        field: "precipitationType", operator: "gte", value: 2,
        level: "poor", label: "Poor",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Severe precipitation expected — protect crops",
      },
      {
        field: "dewPoint", operator: "gt", value: 20,
        level: "fair", label: "Fair",
        colorClass: "text-severity-high", bgClass: "bg-severity-high/10",
        detail: "High dew point — disease risk for crops",
        metricTemplate: "Dew: {value}\u00B0C",
      },
      {
        field: "dewPoint", operator: "lt", value: 5,
        level: "poor", label: "Poor",
        colorClass: "text-severity-cold", bgClass: "bg-severity-cold/10",
        detail: "Low dew point — cold, dry air stress for crops",
        metricTemplate: "Dew: {value}\u00B0C",
      },
      {
        field: "evapotranspiration", operator: "gt", value: 5,
        level: "fair", label: "Fair",
        colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10",
        detail: "High water loss — irrigate early",
        metricTemplate: "ET: {value} mm",
      },
    ],
    fallback: {
      level: "good", label: "Good",
      colorClass: "text-severity-low", bgClass: "bg-severity-low/10",
      detail: "Favorable conditions for fieldwork",
    },
  },

  // ── Category: Mining ────────────────────────────────────────────────────
  {
    key: "category:mining",
    conditions: [
      {
        field: "thunderstormProbability", operator: "gt", value: 50,
        level: "poor", label: "Poor",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Suspend outdoor operations — lightning risk",
        metricTemplate: "Storm: {value}%",
      },
      {
        field: "heatStressIndex", operator: "gte", value: 28,
        level: "poor", label: "Poor",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Severe heat stress — mandatory rest breaks",
        metricTemplate: "Heat: {value}",
      },
      {
        field: "heatStressIndex", operator: "gte", value: 24,
        level: "fair", label: "Fair",
        colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10",
        detail: "Moderate heat stress — hydration breaks needed",
        metricTemplate: "Heat: {value}",
      },
      {
        field: "thunderstormProbability", operator: "gt", value: 20,
        level: "fair", label: "Fair",
        colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10",
        detail: "Monitor storm conditions closely",
        metricTemplate: "Storm: {value}%",
      },
    ],
    fallback: {
      level: "good", label: "Good",
      colorClass: "text-severity-low", bgClass: "bg-severity-low/10",
      detail: "Safe conditions for outdoor work",
    },
  },

  // ── Category: Sports ────────────────────────────────────────────────────
  {
    key: "category:sports",
    conditions: [
      {
        field: "thunderstormProbability", operator: "gt", value: 40,
        level: "poor", label: "Poor",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Move indoors — thunderstorm risk",
        metricTemplate: "Storm: {value}%",
      },
      {
        field: "heatStressIndex", operator: "gte", value: 28,
        level: "poor", label: "Poor",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Too hot for outdoor exercise",
        metricTemplate: "Heat: {value}",
      },
      {
        field: "uvHealthConcern", operator: "gt", value: 7,
        level: "fair", label: "Fair",
        colorClass: "text-severity-high", bgClass: "bg-severity-high/10",
        detail: "Very high UV — sun protection essential",
        metricTemplate: "UV: {value}",
      },
      {
        field: "heatStressIndex", operator: "gte", value: 24,
        level: "fair", label: "Fair",
        colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10",
        detail: "Warm — stay hydrated during exercise",
        metricTemplate: "Heat: {value}",
      },
    ],
    fallback: {
      level: "excellent", label: "Excellent",
      colorClass: "text-severity-low", bgClass: "bg-severity-low/10",
      detail: "Great conditions for outdoor activity",
    },
  },

  // ── Category: Travel ────────────────────────────────────────────────────
  {
    key: "category:travel",
    conditions: [
      {
        field: "visibility", operator: "lt", value: 1,
        level: "poor", label: "Poor",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Very poor visibility — delay travel if possible",
        metricTemplate: "Vis: {value} km",
      },
      {
        field: "thunderstormProbability", operator: "gt", value: 50,
        level: "poor", label: "Poor",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Storm risk — avoid unnecessary travel",
        metricTemplate: "Storm: {value}%",
      },
      {
        field: "visibility", operator: "lt", value: 5,
        level: "fair", label: "Fair",
        colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10",
        detail: "Reduced visibility — drive with caution",
        metricTemplate: "Vis: {value} km",
      },
      {
        field: "precipitationType", operator: "gt", value: 0,
        level: "fair", label: "Fair",
        colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10",
        detail: "Precipitation — wet road conditions",
      },
    ],
    fallback: {
      level: "good", label: "Good",
      colorClass: "text-severity-low", bgClass: "bg-severity-low/10",
      detail: "Clear conditions for travel",
    },
  },

  // ── Category: Tourism ───────────────────────────────────────────────────
  {
    key: "category:tourism",
    conditions: [
      {
        field: "uvHealthConcern", operator: "gt", value: 7,
        level: "fair", label: "Fair",
        colorClass: "text-severity-high", bgClass: "bg-severity-high/10",
        detail: "Very high UV — seek shade during midday",
        metricTemplate: "UV: {value}",
      },
      {
        field: "visibility", operator: "lt", value: 5,
        level: "fair", label: "Fair",
        colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10",
        detail: "Limited visibility may affect game viewing",
        metricTemplate: "Vis: {value} km",
      },
    ],
    fallback: {
      level: "good", label: "Good",
      colorClass: "text-severity-low", bgClass: "bg-severity-low/10",
      detail: "Good conditions for outdoor activities",
    },
  },

  // ── Activity: Stargazing (overrides tourism — cloud ceiling is primary concern)
  {
    key: "activity:stargazing",
    conditions: [
      {
        field: "cloudCeiling", operator: "lt", value: 3,
        level: "poor", label: "Poor",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Low cloud ceiling — sky likely obscured",
        metricTemplate: "Ceiling: {value} km",
      },
      {
        field: "visibility", operator: "lt", value: 5,
        level: "fair", label: "Fair",
        colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10",
        detail: "Reduced atmospheric clarity — hazy skies",
        metricTemplate: "Vis: {value} km",
      },
      {
        field: "thunderstormProbability", operator: "gt", value: 30,
        level: "poor", label: "Poor",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Storm risk — poor stargazing conditions",
        metricTemplate: "Storm: {value}%",
      },
    ],
    fallback: {
      level: "excellent", label: "Excellent",
      colorClass: "text-severity-low", bgClass: "bg-severity-low/10",
      detail: "Clear skies expected — great for stargazing",
    },
  },

  // ── Category: Casual ────────────────────────────────────────────────────
  {
    key: "category:casual",
    conditions: [
      {
        field: "thunderstormProbability", operator: "gt", value: 40,
        level: "poor", label: "Poor",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Thunderstorm risk — stay indoors",
        metricTemplate: "Storm: {value}%",
      },
      {
        field: "heatStressIndex", operator: "gte", value: 28,
        level: "fair", label: "Fair",
        colorClass: "text-severity-high", bgClass: "bg-severity-high/10",
        detail: "Very warm — limit time outdoors",
        metricTemplate: "Heat: {value}",
      },
      {
        field: "uvHealthConcern", operator: "gt", value: 7,
        level: "fair", label: "Fair",
        colorClass: "text-severity-high", bgClass: "bg-severity-high/10",
        detail: "High UV — wear sunscreen and a hat",
        metricTemplate: "UV: {value}",
      },
    ],
    fallback: {
      level: "excellent", label: "Excellent",
      colorClass: "text-severity-low", bgClass: "bg-severity-low/10",
      detail: "Perfect for outdoor plans",
    },
  },

  // ── Activity: Conservation (overrides tourism — visibility and storms critical)
  {
    key: "activity:conservation",
    conditions: [
      {
        field: "thunderstormProbability", operator: "gt", value: 40,
        level: "poor", label: "Poor",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Storm risk — suspend field patrols",
        metricTemplate: "Storm: {value}%",
      },
      {
        field: "visibility", operator: "lt", value: 2,
        level: "poor", label: "Poor",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Very low visibility — unsafe for bush patrols",
        metricTemplate: "Vis: {value} km",
      },
      {
        field: "heatStressIndex", operator: "gte", value: 28,
        level: "fair", label: "Fair",
        colorClass: "text-severity-high", bgClass: "bg-severity-high/10",
        detail: "Extreme heat — limit patrol duration, carry extra water",
        metricTemplate: "Heat: {value}",
      },
    ],
    fallback: {
      level: "good", label: "Good",
      colorClass: "text-severity-low", bgClass: "bg-severity-low/10",
      detail: "Good conditions for field operations",
    },
  },

  // ── Activity: Shipping/Marine (overrides travel — wind and visibility critical)
  {
    key: "activity:shipping",
    conditions: [
      {
        field: "windGust", operator: "gt", value: 50,
        level: "poor", label: "Dangerous",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Dangerous gusts — vessels should seek harbour",
        metricTemplate: "Gust: {value} km/h",
      },
      {
        field: "windSpeed", operator: "gt", value: 40,
        level: "poor", label: "Poor",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Strong winds — small craft warning",
        metricTemplate: "Wind: {value} km/h",
      },
      {
        field: "thunderstormProbability", operator: "gt", value: 30,
        level: "poor", label: "Poor",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Storm risk — avoid open water",
        metricTemplate: "Storm: {value}%",
      },
      {
        field: "visibility", operator: "lt", value: 2,
        level: "fair", label: "Fair",
        colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10",
        detail: "Reduced visibility — navigate with caution",
        metricTemplate: "Vis: {value} km",
      },
    ],
    fallback: {
      level: "good", label: "Good",
      colorClass: "text-severity-low", bgClass: "bg-severity-low/10",
      detail: "Calm conditions for marine operations",
    },
  },

  // ── Activity: Drone Flying (overrides casual) ───────────────────────────
  {
    key: "activity:drone-flying",
    conditions: [
      {
        field: "windGust", operator: "gt", value: 40,
        level: "poor", label: "Grounded",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Dangerous gusts — do not fly",
        metricTemplate: "Gust: {value} km/h",
      },
      {
        field: "windSpeed", operator: "gt", value: 35,
        level: "poor", label: "Grounded",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Wind too strong for safe flight",
        metricTemplate: "Wind: {value} km/h",
      },
      {
        field: "thunderstormProbability", operator: "gt", value: 20,
        level: "poor", label: "Grounded",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Storm risk — do not fly",
        metricTemplate: "Storm: {value}%",
      },
      {
        field: "visibility", operator: "lt", value: 1,
        level: "poor", label: "Grounded",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Visibility too low for safe flight",
        metricTemplate: "Vis: {value} km",
      },
      {
        field: "precipitationType", operator: "gt", value: 0,
        level: "poor", label: "Grounded",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Precipitation — moisture risk to electronics",
      },
      {
        field: "windGust", operator: "gt", value: 25,
        level: "fair", label: "Caution",
        colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10",
        detail: "Gusty conditions — fly low, avoid open areas",
        metricTemplate: "Gust: {value} km/h",
      },
      {
        field: "windSpeed", operator: "gt", value: 20,
        level: "fair", label: "Caution",
        colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10",
        detail: "Moderate wind — reduced battery life and stability",
        metricTemplate: "Wind: {value} km/h",
      },
      {
        field: "visibility", operator: "lt", value: 3,
        level: "fair", label: "Caution",
        colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10",
        detail: "Reduced visibility — fly with caution, maintain line of sight",
        metricTemplate: "Vis: {value} km",
      },
      {
        field: "uvHealthConcern", operator: "gt", value: 8,
        level: "fair", label: "Fair",
        colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10",
        detail: "Extreme UV — protect yourself while operating",
        metricTemplate: "UV: {value}",
      },
    ],
    fallback: {
      level: "excellent", label: "Flyable",
      colorClass: "text-severity-low", bgClass: "bg-severity-low/10",
      detail: "Clear skies, calm winds — ideal drone conditions",
    },
  },
];
