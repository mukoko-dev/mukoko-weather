/**
 * Database-driven suitability evaluation engine.
 *
 * Evaluates weather insight data against rules stored in MongoDB.
 * Falls back to hardcoded rules when the database is unavailable.
 */

import type { Activity } from "./activities";
import type { SuitabilityRuleDoc, SuitabilityCondition } from "./db";
import type { WeatherInsights } from "./weather";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SuitabilityRating {
  level: "excellent" | "good" | "fair" | "poor";
  label: string;
  colorClass: string;
  bgClass: string;
  detail: string;
  metric?: string;
}

// ---------------------------------------------------------------------------
// Evaluation engine
// ---------------------------------------------------------------------------

/**
 * Compare a weather insight field against a threshold using the given operator.
 */
function compareValue(actual: number, operator: SuitabilityCondition["operator"], threshold: number): boolean {
  switch (operator) {
    case "gt": return actual > threshold;
    case "gte": return actual >= threshold;
    case "lt": return actual < threshold;
    case "lte": return actual <= threshold;
    // eq uses strict equality — safe for integer-valued alert levels (e.g., uvHealthConcern).
    // Not suitable for continuous float measurements due to JSON round-trip precision.
    case "eq": return actual === threshold;
    default: return false;
  }
}

/** Fields that display one decimal place instead of rounding to integer. */
const DECIMAL_FIELDS = new Set(["visibility", "evapotranspiration"]);

/**
 * Resolve a metric template by replacing {field} placeholders with actual values.
 * Supports {value} (the matched field's value) and {fieldName} for any insight field.
 */
function resolveMetric(
  template: string | undefined,
  insights: WeatherInsights,
  matchedField?: string,
  matchedValue?: number,
): string | undefined {
  if (!template) return undefined;
  let resolved = template;

  // Replace {value} with the matched condition's value
  if (matchedValue != null) {
    resolved = resolved.replace("{value}", matchedValue.toFixed(DECIMAL_FIELDS.has(matchedField ?? "") ? 1 : 0));
  }

  // Replace any {fieldName} placeholders with actual insight values
  const insightRecord = insights as Record<string, unknown>;
  resolved = resolved.replace(/\{(\w+)\}/g, (match, field) => {
    const val = insightRecord[field];
    if (val == null) return match;
    if (typeof val === "number") {
      return DECIMAL_FIELDS.has(field) ? val.toFixed(1) : Math.round(val).toString();
    }
    return String(val);
  });

  // If any unresolved placeholders remain, omit the metric
  if (resolved.includes("{")) return undefined;

  return resolved;
}

/**
 * Evaluate weather insights against a suitability rule set.
 * Conditions are checked in order — first match wins.
 */
export function evaluateRule(rule: SuitabilityRuleDoc, insights: WeatherInsights): SuitabilityRating {
  const insightRecord = insights as Record<string, unknown>;

  for (const condition of rule.conditions) {
    const fieldValue = insightRecord[condition.field];
    if (fieldValue == null || typeof fieldValue !== "number") continue;

    if (compareValue(fieldValue, condition.operator, condition.value)) {
      return {
        level: condition.level,
        label: condition.label,
        colorClass: condition.colorClass,
        bgClass: condition.bgClass,
        detail: condition.detail,
        metric: resolveMetric(condition.metricTemplate, insights, condition.field, fieldValue),
      };
    }
  }

  // No condition matched — use fallback
  return {
    level: rule.fallback.level,
    label: rule.fallback.label,
    colorClass: rule.fallback.colorClass,
    bgClass: rule.fallback.bgClass,
    detail: rule.fallback.detail,
    metric: resolveMetric(rule.fallback.metricTemplate, insights),
  };
}

// ---------------------------------------------------------------------------
// Activity-level suitability resolution (rule lookup + evaluation)
// ---------------------------------------------------------------------------

/** Generic fallback when no DB rules exist for a category */
const GENERIC_FALLBACK: SuitabilityRating = {
  level: "fair",
  label: "Fair",
  colorClass: "text-severity-moderate",
  bgClass: "bg-severity-moderate/10",
  detail: "No specific rules available for this activity",
};

/**
 * Resolve the best suitability rule for an activity and evaluate it.
 * Lookup order: activity-specific rule → category rule → generic fallback.
 */
export function evaluateSuitability(
  activity: Activity,
  insights: WeatherInsights,
  dbRules: Map<string, SuitabilityRuleDoc>,
): SuitabilityRating {
  // 1. Try activity-specific rule from database
  const activityRule = dbRules.get(`activity:${activity.id}`);
  if (activityRule) return evaluateRule(activityRule, insights);

  // 2. Try category rule from database
  const categoryRule = dbRules.get(`category:${activity.category}`);
  if (categoryRule) return evaluateRule(categoryRule, insights);

  // 3. Generic fallback — all rules should be in DB, but safety net
  return GENERIC_FALLBACK;
}
