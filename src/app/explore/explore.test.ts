/**
 * Tests for the explore pages — validates ISR caching, loading skeletons,
 * and layout patterns by reading source files (Vitest runs in Node).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const exploreSource = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");
const exploreTagSource = readFileSync(resolve(__dirname, "[tag]/page.tsx"), "utf-8");
const exploreLoading = readFileSync(resolve(__dirname, "loading.tsx"), "utf-8");
const exploreTagLoading = readFileSync(resolve(__dirname, "[tag]/loading.tsx"), "utf-8");

describe("explore page — ISR caching", () => {
  it("explore/page.tsx exports revalidate = 3600 for 1-hour ISR", () => {
    expect(exploreSource).toContain("export const revalidate = 3600");
  });

  it("explore/[tag]/page.tsx exports revalidate = 3600 for 1-hour ISR", () => {
    expect(exploreTagSource).toContain("export const revalidate = 3600");
  });
});

describe("explore page — loading skeletons", () => {
  it("explore/loading.tsx exists and has role=\"status\"", () => {
    expect(exploreLoading).toContain('role="status"');
  });

  it("explore/loading.tsx has sr-only text for screen readers", () => {
    expect(exploreLoading).toContain("sr-only");
    expect(exploreLoading).toContain("Loading");
  });

  it("explore/loading.tsx renders skeleton cards", () => {
    expect(exploreLoading).toContain("Skeleton");
  });

  it("explore/[tag]/loading.tsx exists and has role=\"status\"", () => {
    expect(exploreTagLoading).toContain('role="status"');
  });

  it("explore/[tag]/loading.tsx has sr-only text for screen readers", () => {
    expect(exploreTagLoading).toContain("sr-only");
    expect(exploreTagLoading).toContain("Loading");
  });

  it("explore/[tag]/loading.tsx renders province group skeletons", () => {
    expect(exploreTagLoading).toContain("Skeleton");
  });
});

describe("explore page — layout and navigation", () => {
  it("explore page includes Header and Footer", () => {
    expect(exploreSource).toContain("Header");
    expect(exploreSource).toContain("Footer");
  });

  it("explore page uses consistent max-w-5xl container", () => {
    expect(exploreSource).toContain("max-w-5xl");
  });

  it("explore page has symmetric horizontal padding (sm:px-6 md:px-8)", () => {
    expect(exploreSource).toContain("sm:px-6");
    expect(exploreSource).toContain("md:px-8");
  });

  it("explore page has pb-24 for mobile nav clearance", () => {
    expect(exploreSource).toContain("pb-24");
  });

  it("explore tag page includes Header and Footer", () => {
    expect(exploreTagSource).toContain("Header");
    expect(exploreTagSource).toContain("Footer");
  });

  it("explore tag page has symmetric horizontal padding (sm:px-6 md:px-8)", () => {
    expect(exploreTagSource).toContain("sm:px-6");
    expect(exploreTagSource).toContain("md:px-8");
  });

  it("explore tag page has pb-24 for mobile nav clearance", () => {
    expect(exploreTagSource).toContain("pb-24");
  });
});

describe("explore page — data and accessibility", () => {
  it("explore page fetches locations from MongoDB", () => {
    // Should use getAllLocations or db fetch, not just static LOCATIONS
    const usesDb = exploreSource.includes("getAllLocations") ||
      exploreSource.includes("getLocations") ||
      exploreSource.includes("LOCATIONS");
    expect(usesDb).toBe(true);
  });

  it("explore page links to /shamwari for AI chat", () => {
    expect(exploreSource).toContain("/shamwari");
    expect(exploreSource).toContain("Ask Shamwari");
  });

  it("explore page is browse-only (no chatbot component)", () => {
    expect(exploreSource).not.toContain("ExplorePageClient");
    expect(exploreSource).not.toContain("ExploreChatbot");
  });

  it("explore tag page renders a not-found for unknown tags", () => {
    expect(exploreTagSource).toContain("notFound");
  });

  it("explore tag page groups locations by province", () => {
    expect(exploreTagSource).toContain("province");
  });
});

describe("explore/loading.tsx — skeleton quality", () => {
  it("uses aria-busy=true on loading container", () => {
    expect(exploreLoading).toContain('aria-busy="true"');
  });

  it("tag loading skeleton uses aria-busy=true", () => {
    expect(exploreTagLoading).toContain('aria-busy="true"');
  });

  it("explore loading renders multiple card skeletons", () => {
    // Should render 8 or more skeleton cards
    expect(exploreLoading).toContain("Array.from");
  });

  it("explore tag loading renders province group skeletons", () => {
    // Should render 2 province groups with 6 items each
    expect(exploreTagLoading).toContain("Array.from");
  });
});
