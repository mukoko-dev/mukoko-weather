import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const dir = resolve(__dirname);
const read = (f: string) => readFileSync(resolve(dir, f), "utf-8");
const page = read("page.tsx");
const dashboard = read("AgricultureDashboard.tsx");

describe("/[location]/agriculture route", () => {
  it("has page, dashboard, loading and error files", () => {
    for (const f of [
      "page.tsx",
      "AgricultureDashboard.tsx",
      "loading.tsx",
      "error.tsx",
    ]) {
      expect(existsSync(resolve(dir, f)), f).toBe(true);
    }
  });

  it("is a server page with its own canonical, OG and JSON-LD", () => {
    expect(page).not.toContain('"use client"');
    expect(page).toContain("canonical: `${SITE_URL}/${loc.slug}/agriculture`");
    expect(page).toContain("openGraph");
    expect(page).toContain('"@type": "BreadcrumbList"');
    expect(page).toContain('"@type": "WebPage"');
    expect(page).toContain('unitCode: "MTR"');
    expect(page).toContain("safeJsonLd(");
    expect(page).toContain("notFound()");
  });

  it("is public: no sign-in gate on the page; the user only unlocks the AI briefing", () => {
    expect(page).not.toContain("requireUser");
    expect(page).toContain("getCurrentUser()");
  });

  it("renders the shared breadcrumb trail through PageShell", () => {
    expect(dashboard).toContain("<PageShell");
    expect(dashboard).toContain("breadcrumb={[");
    expect(dashboard).toContain('{ label: "Agriculture" }');
    expect(dashboard).not.toContain("<Header />");
    expect(dashboard).not.toContain("<Footer />");
  });

  it("wraps every section in an error boundary, lazy sections in LazySection", () => {
    for (const name of [
      "agriculture snapshot",
      "agronomy briefing",
      "crop advice",
      "agriculture charts",
      "crop calendar",
      "history against normals",
      "ENSO outlook",
    ]) {
      expect(dashboard, name).toContain(`<ChartErrorBoundary name="${name}">`);
    }
    for (const label of [
      "agriculture-briefing",
      "agriculture-crop-advice",
      "agriculture-charts",
      "agriculture-calendar",
      "agriculture-history",
      "agriculture-enso",
    ]) {
      expect(dashboard, label).toContain(`label="${label}"`);
    }
  });

  it("reuses the snapshot card in page mode and the shared ENSO card", () => {
    expect(dashboard).toContain('variant="page"');
    expect(dashboard).toContain("@/components/weather/EnsoOutlook");
  });

  it("loading and error states follow the sub-route pattern", () => {
    expect(read("loading.tsx")).toContain("<PageShellSkeleton");
    expect(read("loading.tsx")).toContain("breadcrumb");
    expect(read("error.tsx")).toContain("RouteErrorBoundary");
  });

  it("is in the sitemap for farming locations only (content loads client-side)", () => {
    const sitemap = readFileSync(resolve(dir, "../../sitemap.ts"), "utf-8");
    expect(sitemap).toContain("${loc.slug}/agriculture");
    expect(sitemap).toContain('loc.tags.includes("farming")');
  });

  it("never becomes the lastLocation cookie: the proxy reads only the first segment", () => {
    const proxy = readFileSync(resolve(dir, "../../../proxy.ts"), "utf-8");
    expect(proxy).toContain('pathname.slice(1).split("/")[0]');
  });

  it("has no hardcoded colours, inline styles or lint suppressions", () => {
    for (const src of [
      page,
      dashboard,
      read("loading.tsx"),
      read("error.tsx"),
    ]) {
      expect(src).not.toMatch(/#[0-9a-fA-F]{6}\b/);
      expect(src).not.toContain("style={{");
      expect(src).not.toContain("eslint-disable");
    }
  });
});
