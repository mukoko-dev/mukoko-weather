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

  it("asks AI through the cached, auth-gated client, snapshot mode, only for farmers", () => {
    const client = fs.readFileSync("src/lib/agriculture-client.ts", "utf-8");
    expect(client).toContain('"/api/ai/agriculture"');
    expect(src).not.toContain("/api/py/ai/");
    expect(src).toContain('"snapshot"');
    expect(src).toContain("const wantsAI = isCard && signedIn && crops.length > 0;");
    expect(src).toContain("fetchAgriAI(aiBody)");
    // Not gated on the client data fetch — both start in parallel.
    expect(src).not.toContain("if (!ready");
  });

  it("page variant drops the AI line and the self-link", () => {
    expect(src).toContain('variant = "card"');
    expect(src).toContain("{isCard && (");
  });

  it("asks signed-in users without crops to pick them", () => {
    expect(src).toContain('openMyWeather("activities")');
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

  it("uses the shared .meerkat stat tile", () => {
    expect(src).toContain('className="meerkat"');
    expect(src).not.toContain("rounded-card bg-surface-dim p-3");
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
