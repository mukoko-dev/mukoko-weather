import { describe, it, expect } from "vitest";
import fs from "fs";

const src = fs.readFileSync(
  "src/components/weather/AgricultureSnapshot.tsx",
  "utf-8",
);
const dashboard = fs.readFileSync(
  "src/app/[location]/WeatherDashboard.tsx",
  "utf-8",
);
const skeletons = fs.readFileSync(
  "src/components/weather/SectionSkeleton.tsx",
  "utf-8",
);

describe("AgricultureSnapshot", () => {
  it("fetches the public deterministic endpoint", () => {
    expect(src).toContain("agricultureUrl(location, crops)");
  });

  it("asks AI only through the auth-gated proxy, snapshot mode, signed-in only", () => {
    expect(src).toContain('"/api/ai/agriculture"');
    expect(src).not.toContain("/api/py/ai/");
    expect(src).toContain('mode: "snapshot"');
    expect(src).toContain("if (!ready || !signedIn) return;");
  });

  it("offers sign-in to anonymous users with a returnTo", () => {
    expect(src).toContain("/auth/signin?returnTo=");
  });

  it("links to the full insights page", () => {
    expect(src).toContain("`/${location.slug}/agriculture`");
    expect(src).toContain("Full agriculture insights →");
  });

  it("is labelled by its heading and uses the malachite (farming) mineral", () => {
    expect(src).toContain('aria-labelledby="agri-snapshot-heading"');
    expect(src).toContain('id="agri-snapshot-heading"');
    expect(src).toContain("border-l-mineral-malachite");
  });

  it("renders nothing on failure or unavailable data (no empty card)", () => {
    expect(src).toContain("if (!isAgricultureReady(data)) return null;");
  });

  it("uses tokens only: no hex, rgba or inline styles; no lint suppressions", () => {
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/rgba?\(/);
    expect(src).not.toContain("style={{");
    expect(src).not.toContain("eslint-disable");
  });

  it("is a Section-tier block on the location page", () => {
    expect(dashboard).toContain('case "agriculture":');
    expect(dashboard).toContain('label="agriculture-snapshot"');
    expect(dashboard).toContain(
      '<ChartErrorBoundary name="agriculture snapshot">',
    );
    expect(dashboard).toContain("fallback={<AgricultureSnapshotSkeleton />}");
  });

  it("has an accessible, aspect-matched skeleton", () => {
    expect(skeletons).toContain("export function AgricultureSnapshotSkeleton");
    expect(skeletons).toContain('aria-label="Loading agriculture snapshot"');
  });
});
