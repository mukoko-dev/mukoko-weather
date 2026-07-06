import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "Breadcrumb.tsx"), "utf-8");

/**
 * Breadcrumb — shared trail for location sub-routes (atmosphere, forecast,
 * map). Centralizes the Home / Location / Current-page pattern previously
 * hand-rolled separately in each sub-route dashboard.
 */

describe("Breadcrumb structure", () => {
  it("exports Breadcrumb", () => {
    expect(source).toContain("export function Breadcrumb");
  });

  it("uses a nav with aria-label=Breadcrumb", () => {
    expect(source).toContain('aria-label="Breadcrumb"');
  });

  it("marks the current page with aria-current and no link", () => {
    expect(source).toContain('aria-current={item.href ? undefined : "page"}');
  });

  it("hides separators from assistive tech", () => {
    expect(source).toContain('aria-hidden="true"');
  });

  it("uses global styles only — no hardcoded colors", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}[^)]/);
    expect(source).not.toContain("style={{");
  });
});

describe("Breadcrumb usage sites", () => {
  const usageFiles = [
    "../../app/[location]/atmosphere/AtmosphereDashboard.tsx",
    "../../app/[location]/forecast/ForecastDashboard.tsx",
    "../../app/[location]/map/MapDashboard.tsx",
  ];

  it("is imported by all three location sub-route dashboards", () => {
    for (const file of usageFiles) {
      const dashboardSource = readFileSync(resolve(__dirname, file), "utf-8");
      expect(dashboardSource).toContain("@/components/layout/Breadcrumb");
      expect(dashboardSource).toContain("<Breadcrumb");
    }
  });

  it("MapDashboard no longer renders a floating back-to-weather pill", () => {
    const mapSource = readFileSync(
      resolve(__dirname, "../../app/[location]/map/MapDashboard.tsx"),
      "utf-8"
    );
    expect(mapSource).not.toContain("Back to weather");
  });
});

describe("BreadcrumbSkeleton (issue #104)", () => {
  const source = readFileSync(resolve(__dirname, "Breadcrumb.tsx"), "utf-8");

  it("exports a skeleton matching the real trail's container classes", () => {
    expect(source).toContain("export function BreadcrumbSkeleton");
    // Same outer classes as the real Breadcrumb nav — no layout shift on hydrate.
    const occurrences = source.split("mx-auto max-w-5xl px-4 pt-4 sm:px-6 md:px-8").length - 1;
    expect(occurrences).toBe(2); // skeleton + real component
  });

  it("is announced as a loading status", () => {
    expect(source).toContain('role="status"');
    expect(source).toContain('aria-label="Loading"');
  });

  it("replaces the hand-rolled skeletons in all three sub-route loading files", () => {
    for (const file of [
      "../../app/[location]/atmosphere/loading.tsx",
      "../../app/[location]/forecast/loading.tsx",
      "../../app/[location]/map/loading.tsx",
    ]) {
      const loadingSource = readFileSync(resolve(__dirname, file), "utf-8");
      expect(loadingSource).toContain("<BreadcrumbSkeleton");
      expect(loadingSource).not.toContain('<span className="text-text-tertiary/30">/</span>');
    }
  });
});
