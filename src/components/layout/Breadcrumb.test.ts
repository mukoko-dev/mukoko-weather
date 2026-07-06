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
