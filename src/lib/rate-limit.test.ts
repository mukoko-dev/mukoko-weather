import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "rate-limit.ts"), "utf-8");

describe("rate-limit module structure", () => {
  it("exports checkRateLimit function", () => {
    expect(source).toContain("export async function checkRateLimit");
  });

  it("uses MongoDB rateLimitsCollection", () => {
    expect(source).toContain("rateLimitsCollection");
  });

  it("accepts ip, action, maxRequests, windowSeconds params", () => {
    expect(source).toContain("ip: string");
    expect(source).toContain("action: string");
    expect(source).toContain("maxRequests: number");
    expect(source).toContain("windowSeconds: number");
  });

  it("returns allowed, remaining, and resetAt fields", () => {
    expect(source).toContain("allowed:");
    expect(source).toContain("remaining:");
    expect(source).toContain("resetAt:");
  });

  it("uses atomic findOneAndUpdate for concurrency safety", () => {
    expect(source).toContain("findOneAndUpdate");
  });

  it("uses $inc for atomic counter increment", () => {
    expect(source).toContain("$inc");
  });

  it("uses $setOnInsert for expiry on first request only", () => {
    expect(source).toContain("$setOnInsert");
  });

  it("compares count against maxRequests", () => {
    expect(source).toContain("count <= maxRequests");
  });
});
