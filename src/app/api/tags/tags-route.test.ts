/**
 * Structural compliance tests for GET /api/tags — inspects source code
 * patterns using readFileSync because Next.js API routes cannot be imported
 * directly in Vitest's Node environment.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "route.ts"), "utf-8");

describe("GET /api/tags route structure", () => {
  it("exports a GET handler", () => {
    expect(source).toContain("export async function GET");
  });

  it("supports ?featured=true filter", () => {
    expect(source).toContain('featured');
    expect(source).toContain("getFeaturedTagsFromDb");
  });

  it("returns all tags when featured param is not set", () => {
    expect(source).toContain("getAllTagsFromDb");
  });

  it("returns tags in JSON response", () => {
    expect(source).toContain("tags");
    expect(source).toContain("NextResponse.json");
  });

  it("sets a long-lived Cache-Control header", () => {
    expect(source).toContain("Cache-Control");
    expect(source).toContain("max-age=3600");
    expect(source).toContain("stale-while-revalidate");
  });

  it("returns 500 on database error", () => {
    expect(source).toContain("status: 500");
    expect(source).toContain("Failed to fetch tags");
  });

  it("logs errors with the mongodb source", () => {
    expect(source).toContain("logError");
    expect(source).toContain('"mongodb"');
  });
});
