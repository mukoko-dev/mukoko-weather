/**
 * PageShell — the shared chrome for static content pages. Verified by reading
 * the source (Vitest runs in Node without a DOM).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "PageShell.tsx"), "utf-8");

describe("PageShell", () => {
  it("wraps content in Header and Footer", () => {
    expect(source).toContain("<Header />");
    expect(source).toContain("<Footer />");
  });

  it("renders the main landmark with the skip-link target (page + skeleton)", () => {
    expect(source).toContain('id="main-content"');
    expect(source.match(/^\s+<main$/gm)?.length).toBe(2);
  });

  it("clears the mobile nav island with --mobile-nav-clearance and restores at sm", () => {
    expect(source).toContain(
      "pb-[var(--mobile-nav-clearance)] sm:px-6 sm:pb-8",
    );
  });

  it("names its widths after the Mzizi page layouts", () => {
    for (const k of [
      "feed",
      "settings",
      "prose",
      "detail",
      "wide",
      "dashboard",
    ]) {
      expect(source).toContain(`${k}: "max-w-`);
    }
    expect(source).toContain("mzizi-page");
  });

  it("has no inline styles or hardcoded colours", () => {
    expect(source).not.toContain("style={{");
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});

describe("every ordinary page route has a loader and an error boundary", () => {
  const routes = [
    "history",
    "profile",
    "status",
    "locations",
    "releases",
    "developers/keys",
  ];
  for (const r of routes) {
    it(`${r}: loading.tsx uses PageShellSkeleton and error.tsx uses RouteErrorBoundary`, () => {
      const dir = resolve(__dirname, "../../app", r);
      expect(existsSync(`${dir}/loading.tsx`)).toBe(true);
      expect(existsSync(`${dir}/error.tsx`)).toBe(true);
      expect(readFileSync(`${dir}/loading.tsx`, "utf-8")).toContain(
        "PageShellSkeleton",
      );
      expect(readFileSync(`${dir}/error.tsx`, "utf-8")).toContain(
        "RouteErrorBoundary",
      );
    });
  }
});

describe("PageHeaderSkeleton and SkeletonStack", () => {
  it("exports the title+intro placeholder in the PageHeader spacing", () => {
    expect(source).toContain("export function PageHeaderSkeleton");
    expect(source).toContain('className="mb-3 h-9 w-56"');
    expect(source).toContain('className="mb-8 h-4 w-80 max-w-full"');
  });

  it("exports SkeletonStack, rendering `count` items inside one wrapper", () => {
    expect(source).toContain("export function SkeletonStack");
    expect(source).toContain("Array.from({ length: count }");
    expect(source).toContain("<React.Fragment key={i}>");
  });
});
