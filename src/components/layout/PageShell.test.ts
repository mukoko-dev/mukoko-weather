/**
 * PageShell — the shared chrome for static content pages. Verified by reading
 * the source (Vitest runs in Node without a DOM).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
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

  it("supports the 3xl and 5xl reading widths", () => {
    expect(source).toContain('"3xl": "max-w-3xl"');
    expect(source).toContain('"5xl": "max-w-5xl"');
  });

  it("has no inline styles or hardcoded colours", () => {
    expect(source).not.toContain("style={{");
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});
