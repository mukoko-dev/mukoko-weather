/**
 * Structural tests for seed-ai-prompts.ts — ensures data integrity
 * for the database-driven AI prompt library.
 */
import { describe, it, expect } from "vitest";
import { AI_PROMPTS, AI_SUGGESTED_PROMPT_RULES } from "./seed-ai-prompts";
import { ACTIVITIES } from "./activities";

describe("AI_PROMPTS uniqueness and structure", () => {
  it("has no duplicate promptKey values", () => {
    const keys = AI_PROMPTS.map((p) => p.promptKey);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it("all prompts have required fields", () => {
    for (const prompt of AI_PROMPTS) {
      expect(prompt.promptKey).toBeTruthy();
      expect(prompt.template).toBeTruthy();
      expect(prompt.description).toBeTruthy();
      expect(typeof prompt.active).toBe("boolean");
      expect(typeof prompt.order).toBe("number");
    }
  });

  it("system:chat template includes LOCATION DISCOVERY guardrails", () => {
    const chatPrompt = AI_PROMPTS.find((p) => p.promptKey === "system:chat");
    expect(chatPrompt).toBeDefined();
    expect(chatPrompt!.template).toContain("LOCATION DISCOVERY");
    expect(chatPrompt!.template).toContain("{locationCount}");
    expect(chatPrompt!.template).toContain("search_locations");
    expect(chatPrompt!.template).toContain("NEVER assume a location does not exist");
  });

  it("system:chat template includes DATA GUARDRAILS", () => {
    const chatPrompt = AI_PROMPTS.find((p) => p.promptKey === "system:chat");
    expect(chatPrompt!.template).toContain("DATA GUARDRAILS");
  });

  it("system:chat template has all required placeholders", () => {
    const chatPrompt = AI_PROMPTS.find((p) => p.promptKey === "system:chat");
    // These must stay in sync with _apply_template() in api/py/_chat.py
    expect(chatPrompt!.template).toContain("{locationList}");
    expect(chatPrompt!.template).toContain("{locationCount}");
    expect(chatPrompt!.template).toContain("{activityList}");
    expect(chatPrompt!.template).toContain("{userActivitySection}");
  });

  it("includes all expected system prompt keys", () => {
    const keys = AI_PROMPTS.map((p) => p.promptKey);
    expect(keys).toContain("system:summary");
    expect(keys).toContain("system:chat");
    expect(keys).toContain("system:followup");
    expect(keys).toContain("system:history_analysis");
    expect(keys).toContain("system:report_clarification");
    expect(keys).toContain("system:explore_search");
  });
});

describe("AI_SUGGESTED_PROMPT_RULES uniqueness and structure", () => {
  it("has no duplicate ruleId values", () => {
    const ids = AI_SUGGESTED_PROMPT_RULES.map((r) => r.ruleId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("all rules have required fields", () => {
    for (const rule of AI_SUGGESTED_PROMPT_RULES) {
      expect(rule.ruleId).toBeTruthy();
      expect(rule.label).toBeTruthy();
      expect(rule.queryTemplate).toBeTruthy();
      expect(["weather", "activity", "generic"]).toContain(rule.category);
      expect(typeof rule.active).toBe("boolean");
      expect(typeof rule.order).toBe("number");
    }
  });

  it("generic rules have null condition", () => {
    const generic = AI_SUGGESTED_PROMPT_RULES.filter((r) => r.category === "generic");
    expect(generic.length).toBeGreaterThan(0);
    for (const rule of generic) {
      expect(rule.condition).toBeNull();
    }
  });

  it("weather and activity rules have non-null conditions", () => {
    const nonGeneric = AI_SUGGESTED_PROMPT_RULES.filter(
      (r) => r.category === "weather" || r.category === "activity"
    );
    for (const rule of nonGeneric) {
      expect(rule.condition).not.toBeNull();
      expect(rule.condition!.field).toBeTruthy();
      expect(rule.condition!.operator).toBeTruthy();
      expect(rule.condition!.value).toBeDefined();
    }
  });

  it("queryTemplate includes at least one interpolation placeholder", () => {
    for (const rule of AI_SUGGESTED_PROMPT_RULES) {
      expect(rule.queryTemplate).toMatch(/\{[a-zA-Z]+\}/);
    }
  });

  it("activity rule IDs reference actual activities from ACTIVITIES array", () => {
    const activityIds = new Set(ACTIVITIES.map((a) => a.id));
    const activityRules = AI_SUGGESTED_PROMPT_RULES.filter(
      (r) => r.category === "activity" && r.condition?.source === "activities"
    );
    for (const rule of activityRules) {
      const ruleActivityIds = rule.condition!.value as string[];
      for (const id of ruleActivityIds) {
        expect(activityIds.has(id)).toBe(true);
      }
    }
  });

  it("includes rules for conservation and events activities", () => {
    const ruleIds = AI_SUGGESTED_PROMPT_RULES.map((r) => r.ruleId);
    expect(ruleIds).toContain("activity:conservation");
    expect(ruleIds).toContain("activity:events");
    expect(ruleIds).toContain("activity:transport");
  });
});
