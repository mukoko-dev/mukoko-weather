/**
 * Tests for ProfileClient — validates structure, accessibility, and that it
 * reuses the existing My Weather modal rather than duplicating preference UI.
 * Reads source file directly (no DOM renderer needed for structural checks).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "ProfileClient.tsx"), "utf-8");

describe("ProfileClient — component structure", () => {
  it("is a client component", () => {
    expect(source).toContain('"use client"');
  });

  it("exports ProfileClient function", () => {
    expect(source).toContain("export function ProfileClient");
  });

  it("reads openMyWeather from the shared store instead of duplicating preference UI", () => {
    expect(source).toContain("useAppStore");
    expect(source).toContain("openMyWeather");
  });

  it("uses the shared user-display helpers instead of duplicating initials logic", () => {
    expect(source).toContain('from "@/lib/user-display"');
    expect(source).toContain("initialsFor");
    expect(source).toContain("displayNameFor");
  });
});

describe("ProfileClient — account section", () => {
  it("uses the .hoopoe avatar class", () => {
    expect(source).toContain("hoopoe");
  });

  it("shows a profile picture when available, else initials", () => {
    expect(source).toContain("hasPicture");
    expect(source).toContain("<img");
  });

  it("has a sign-out link", () => {
    expect(source).toContain('href="/auth/signout"');
  });
});

describe("ProfileClient — My Weather preferences section", () => {
  it("has an Edit preferences button wired to openMyWeather", () => {
    expect(source).toContain("Edit preferences");
    expect(source).toContain("onClick={openMyWeather}");
  });
});

describe("ProfileClient — accessibility", () => {
  it("uses aria-labelledby with heading ids for both sections", () => {
    expect(source).toContain('aria-labelledby="account-heading"');
    expect(source).toContain('id="account-heading"');
    expect(source).toContain('aria-labelledby="preferences-heading"');
    expect(source).toContain('id="preferences-heading"');
  });
});

describe("ProfileClient — styling", () => {
  it("uses fauna component classes, not hardcoded utility chains", () => {
    expect(source).toContain("baobab");
    expect(source).toContain("acacia");
    expect(source).toContain("kudu-sm");
    expect(source).toContain("impala-sm");
  });

  it("uses brand token classes not hardcoded colors", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});
