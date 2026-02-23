import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "RecentReports.tsx"), "utf-8");

/**
 * RecentReports component tests.
 *
 * Tests the community report list, upvoting, and report-weather trigger.
 */

describe("RecentReports structure", () => {
  it("is a client component", () => {
    expect(source).toContain('"use client"');
  });

  it("exports RecentReports", () => {
    expect(source).toContain("export function RecentReports");
  });

  it("has aria-labelledby for accessibility", () => {
    expect(source).toContain('aria-labelledby="community-reports-heading"');
    expect(source).toContain('id="community-reports-heading"');
  });
});

describe("data fetching", () => {
  it("fetches reports from GET /api/py/reports", () => {
    expect(source).toContain("/api/py/reports?location=");
  });

  it("accepts locationSlug prop", () => {
    expect(source).toContain("locationSlug");
  });

  it("shows loading spinner", () => {
    expect(source).toContain('role="status"');
    expect(source).toContain("sr-only");
    expect(source).toContain("animate-spin");
  });
});

describe("report display", () => {
  it("shows report type icons", () => {
    expect(source).toContain("REPORT_ICONS");
  });

  it("shows severity badges with severity tokens", () => {
    expect(source).toContain("SEVERITY_CLASSES");
    expect(source).toContain("severity-low");
    expect(source).toContain("severity-moderate");
    expect(source).toContain("severity-severe");
  });

  it("shows verified badge", () => {
    expect(source).toContain("verified");
    expect(source).toContain("Verified");
  });

  it("shows time ago", () => {
    expect(source).toContain("timeAgo");
  });
});

describe("upvoting", () => {
  it("calls POST /api/py/reports/upvote", () => {
    expect(source).toContain("/api/py/reports/upvote");
  });

  it("upvote button has aria-label", () => {
    expect(source).toContain("aria-label=");
    expect(source).toContain("Upvote report");
  });

  it("has 44px minimum touch target for upvote", () => {
    expect(source).toContain("min-h-[44px]");
    expect(source).toContain("min-w-[44px]");
  });
});

describe("report trigger", () => {
  it("has a Report Weather button", () => {
    expect(source).toContain("Report Weather");
  });

  it("opens the report modal via store", () => {
    expect(source).toContain("openReportModal");
  });
});

describe("UI patterns", () => {
  it("uses global styles only — no hardcoded colors", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}[^)]/);
    expect(source).not.toContain("style={{");
  });
});
