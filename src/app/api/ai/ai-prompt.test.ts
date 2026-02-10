import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Tests for AI weather summary prompt configuration.
 * Validates the system prompt instructs the model to return markdown-formatted output.
 */

const routePath = resolve(__dirname, "./route.ts");
const routeContent = readFileSync(routePath, "utf-8");

describe("AI summary system prompt", () => {
  it("instructs the model to use markdown formatting", () => {
    expect(routeContent).toContain("Use markdown formatting");
  });

  it("instructs the model to use bold for emphasis", () => {
    expect(routeContent).toContain("**bold**");
  });

  it("instructs the model to use bullet points for lists", () => {
    expect(routeContent).toContain("bullet points");
  });

  it("instructs the model not to use headings", () => {
    expect(routeContent).toMatch(/[Dd]o not use headings/);
  });

  it("instructs the model not to use emoji", () => {
    expect(routeContent).toContain("Do not use emoji");
  });

  it("keeps responses concise", () => {
    expect(routeContent).toContain("3-4 sentences");
  });

  it("requires actionable recommendations", () => {
    expect(routeContent).toContain("actionable recommendation");
  });

  it("supports user activities for personalized advice", () => {
    expect(routeContent).toContain("activities");
    expect(routeContent).toContain("Tailor advice to these activities");
  });
});
