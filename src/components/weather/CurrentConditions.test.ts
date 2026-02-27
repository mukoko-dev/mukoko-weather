/**
 * Tests for CurrentConditions — validates the share button implementation,
 * accessibility attributes, and component structure by reading the source
 * file (Vitest runs in Node without a DOM/React renderer).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "CurrentConditions.tsx"),
  "utf-8",
);

describe("CurrentConditions — client component", () => {
  it("is a client component with 'use client' directive", () => {
    expect(source).toContain('"use client"');
  });

  it("exports CurrentConditions as a named function", () => {
    expect(source).toContain("export function CurrentConditions");
  });
});

describe("CurrentConditions — share button", () => {
  it("imports ShareIcon from weather-icons", () => {
    expect(source).toContain("ShareIcon");
    expect(source).toContain("weather-icons");
  });

  it("accepts a slug prop for constructing share URLs", () => {
    expect(source).toContain("slug?:");
  });

  it("defines a handleShare function", () => {
    expect(source).toContain("handleShare");
  });

  it("uses Web Share API (navigator.share) when available", () => {
    expect(source).toContain("navigator.share");
  });

  it("falls back to clipboard copy when Web Share API is unavailable", () => {
    expect(source).toContain("navigator.clipboard.writeText");
  });

  it("shows 'Copied!' feedback state after clipboard copy", () => {
    expect(source).toContain("Copied!");
    expect(source).toContain("setCopied");
  });

  it("resets copied state after 2 seconds", () => {
    expect(source).toContain("2000");
    expect(source).toContain("setTimeout");
  });

  it("constructs share URL from BASE_URL and slug", () => {
    expect(source).toContain("BASE_URL");
    expect(source).toContain("weather.mukoko.com");
  });

  it("falls back to window.location.href when slug is not provided", () => {
    expect(source).toContain("window.location.href");
  });
});

describe("CurrentConditions — share button accessibility", () => {
  it("share button has aria-label describing the action", () => {
    expect(source).toContain("Share weather for");
    expect(source).toContain("aria-label");
  });

  it("share button meets 44px minimum touch target", () => {
    expect(source).toContain("min-h-[48px]");
    expect(source).toContain("min-w-[48px]");
  });

  it("ShareIcon is aria-hidden to avoid duplicate label", () => {
    expect(source).toContain('aria-hidden="true"');
  });

  it("share button text is sr-only on small screens and visible on sm+", () => {
    expect(source).toContain("sr-only sm:not-sr-only");
  });
});

describe("CurrentConditions — stats grid accessibility", () => {
  it("stats grid has role=\"list\" for semantic grouping", () => {
    expect(source).toContain('role="list"');
    expect(source).toContain('aria-label="Weather statistics"');
  });

  it("QuickStat items have role=\"listitem\"", () => {
    expect(source).toContain('role="listitem"');
  });

  it("temperature display has aria-label with unit", () => {
    expect(source).toContain("degrees Celsius");
    expect(source).toContain("aria-label");
  });
});

describe("CurrentConditions — section accessibility", () => {
  it("wraps content in a <section> with aria-labelledby", () => {
    expect(source).toContain("aria-labelledby");
    expect(source).toContain("current-conditions-heading");
  });

  it("heading is visually hidden (sr-only) to keep visual layout clean", () => {
    expect(source).toContain("sr-only");
    expect(source).toContain("Current weather conditions in");
  });
});
