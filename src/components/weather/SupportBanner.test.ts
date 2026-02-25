/**
 * Tests for SupportBanner — validates isolation, accessibility, and BMC link.
 * Reads source file directly (no DOM renderer needed for structural checks).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "SupportBanner.tsx"), "utf-8");
const dashboardSource = readFileSync(
  resolve(__dirname, "../../app/[location]/WeatherDashboard.tsx"),
  "utf-8",
);

describe("SupportBanner — component structure", () => {
  it("exports SupportBanner function", () => {
    expect(source).toContain("export function SupportBanner");
  });

  it("uses Card primitive for containment", () => {
    expect(source).toContain('from "@/components/ui/card"');
    expect(source).toContain("<Card");
  });

  it("does not import from lucide-react (no external icon dependency)", () => {
    expect(source).not.toContain('from "lucide-react"');
  });

  it("links to the correct Buy Me a Coffee URL", () => {
    expect(source).toContain("https://www.buymeacoffee.com/bryany");
  });

  it("opens link in new tab with noopener noreferrer", () => {
    expect(source).toContain('target="_blank"');
    expect(source).toContain('rel="noopener noreferrer"');
  });
});

describe("SupportBanner — accessibility", () => {
  it("wraps content in a section with aria-labelledby", () => {
    expect(source).toContain("aria-labelledby");
    expect(source).toContain("support-banner-heading");
  });

  it("heading id matches aria-labelledby value", () => {
    expect(source).toContain('id="support-banner-heading"');
    expect(source).toContain('aria-labelledby="support-banner-heading"');
  });

  it("link has descriptive aria-label", () => {
    expect(source).toContain('aria-label="Support mukoko weather — Buy Me a Coffee"');
  });

  it("decorative elements are aria-hidden", () => {
    expect(source).toContain('aria-hidden="true"');
  });
});

describe("SupportBanner — brand styling", () => {
  it("uses --color-bmc token (not hardcoded hex)", () => {
    expect(source).toContain("bg-bmc");
    expect(source).toContain("border-bmc");
    // #FFDD00 is allowed in comments; must not appear in className or style props
    expect(source).not.toMatch(/className=["'`][^"'`]*#FFDD00/);
    expect(source).not.toMatch(/style=\{\{[^}]*#FFDD00/);
  });

  it("uses --color-bmc-fg token for text on yellow", () => {
    expect(source).toContain("text-bmc-fg");
  });
});

describe("SupportBanner — isolation in WeatherDashboard", () => {
  it("is wrapped in a ChartErrorBoundary so crashes stay contained", () => {
    const bmcSection = dashboardSource.match(
      /label="support-banner"[\s\S]*?<\/LazySection>/
    );
    expect(bmcSection).not.toBeNull();
    expect(bmcSection![0]).toContain("ChartErrorBoundary");
    expect(bmcSection![0]).toContain("SupportBanner");
  });

  it("is wrapped in a LazySection so it loads lazily", () => {
    expect(dashboardSource).toContain('label="support-banner"');
  });

  it("appears after community-reports section", () => {
    const reportsPos = dashboardSource.indexOf('label="community-reports"');
    const supportPos = dashboardSource.indexOf('label="support-banner"');
    expect(reportsPos).toBeGreaterThan(-1);
    expect(supportPos).toBeGreaterThan(-1);
    expect(reportsPos).toBeLessThan(supportPos);
  });

  it("appears before location-info section", () => {
    const supportPos = dashboardSource.indexOf('label="support-banner"');
    const locationInfoPos = dashboardSource.indexOf('label="location-info"');
    expect(supportPos).toBeLessThan(locationInfoPos);
  });
});
