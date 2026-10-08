/**
 * Tests for the explore pages — validates ISR caching, loading skeletons,
 * and layout patterns by reading source files (Vitest runs in Node).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const exploreSource = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");
const exploreTagSource = readFileSync(
  resolve(__dirname, "[tag]/page.tsx"),
  "utf-8",
);
const exploreLoading = readFileSync(resolve(__dirname, "loading.tsx"), "utf-8");
const exploreTagLoading = readFileSync(
  resolve(__dirname, "[tag]/loading.tsx"),
  "utf-8",
);
// The shared frame owns role/aria/sr-only for every explore loading route.
const exploreShell = readFileSync(
  resolve(__dirname, "ExploreLoadingShell.tsx"),
  "utf-8",
);

describe("explore page — ISR caching", () => {
  it("explore/page.tsx exports revalidate = 3600 for 1-hour ISR", () => {
    expect(exploreSource).toContain("export const revalidate = 3600");
  });

  it("explore/[tag]/page.tsx exports revalidate = 3600 for 1-hour ISR", () => {
    expect(exploreTagSource).toContain("export const revalidate = 3600");
  });
});

describe("explore page — loading skeletons", () => {
  it('explore/loading.tsx exists and has role="status"', () => {
    expect(exploreShell).toContain('role="status"');
  });

  it("explore/loading.tsx has sr-only text for screen readers", () => {
    expect(exploreShell).toContain("sr-only");
    expect(exploreLoading).toContain("Loading");
  });

  it("explore/loading.tsx renders skeleton cards", () => {
    expect(exploreLoading).toContain("Skeleton");
  });

  it('explore/[tag]/loading.tsx exists and has role="status"', () => {
    expect(exploreShell).toContain('role="status"');
  });

  it("explore/[tag]/loading.tsx has sr-only text for screen readers", () => {
    expect(exploreShell).toContain("sr-only");
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
    const usesDb =
      exploreSource.includes("getAllLocations") ||
      exploreSource.includes("getLocations") ||
      exploreSource.includes("LOCATIONS");
    expect(usesDb).toBe(true);
  });

  it("explore page links to /shamwari for AI chat, gated behind the shamwari_chat feature flag", () => {
    expect(exploreSource).toContain("/shamwari");
    expect(exploreSource).toContain("Ask Shamwari");
    expect(exploreSource).toContain('isFeatureEnabled("shamwari_chat")');
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
    expect(exploreShell).toContain('aria-busy="true"');
  });

  it("tag loading skeleton uses aria-busy=true", () => {
    expect(exploreShell).toContain('aria-busy="true"');
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

describe("explore — shared breadcrumb, empty state and loading shell", () => {
  const pages = {
    index: readFileSync(resolve(__dirname, "page.tsx"), "utf-8"),
    tag: readFileSync(resolve(__dirname, "[tag]/page.tsx"), "utf-8"),
    country: readFileSync(resolve(__dirname, "country/page.tsx"), "utf-8"),
    countryCode: readFileSync(
      resolve(__dirname, "country/[code]/page.tsx"),
      "utf-8",
    ),
    province: readFileSync(
      resolve(__dirname, "country/[code]/[province]/page.tsx"),
      "utf-8",
    ),
  };

  it("every explore page uses the shared Breadcrumb, not a hand-rolled nav", () => {
    for (const source of Object.values(pages)) {
      expect(source).toContain(
        'import { Breadcrumb } from "@/components/layout/Breadcrumb"',
      );
      expect(source).toContain("<Breadcrumb");
      expect(source).not.toContain('aria-label="Breadcrumb"');
      expect(source).not.toContain("<ol className");
    }
  });

  it("explore pages keep an accessible crumb trail with Home and Explore links", () => {
    for (const source of Object.values(pages)) {
      expect(source).toContain('{ label: "Home", href: "/" }');
      expect(source).toContain('{ label: "Explore"');
    }
  });

  it("explore link cards use .card-interactive instead of a hand-rolled hover chain", () => {
    for (const source of Object.values(pages)) {
      expect(source).not.toContain("hover:bg-surface-card/80");
    }
    expect(pages.index).toContain("card-interactive");
    expect(pages.tag).toContain("card-interactive");
    expect(pages.country).toContain("card-interactive");
    expect(pages.countryCode).toContain("card-interactive");
    expect(pages.province).toContain("card-interactive");
  });

  it("empty-list states use the shared EmptyState primitive", () => {
    expect(pages.index).toContain("<EmptyState");
    expect(pages.tag).toContain("<EmptyState");
    expect(pages.countryCode).toContain("<EmptyState");
  });

  it("all five explore loading routes render through ExploreLoadingShell", () => {
    const loadingFiles = [
      "loading.tsx",
      "[tag]/loading.tsx",
      "country/loading.tsx",
      "country/[code]/loading.tsx",
      "country/[code]/[province]/loading.tsx",
    ];
    for (const file of loadingFiles) {
      const source = readFileSync(resolve(__dirname, file), "utf-8");
      expect(source).toContain("ExploreLoadingShell");
      expect(source).toContain("<ExploreLoadingShell");
      // Loading skeletons never mount the live client Header.
      expect(source).not.toContain("<Header");
      expect(source).not.toContain("Footer");
    }
  });

  it("the shared shell uses HeaderSkeleton and BreadcrumbSkeleton", () => {
    expect(exploreShell).toContain("HeaderSkeleton");
    expect(exploreShell).toContain("BreadcrumbSkeleton");
    expect(exploreShell).not.toContain("<Header ");
  });
});
