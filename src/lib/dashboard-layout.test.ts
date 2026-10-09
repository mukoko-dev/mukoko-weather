import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAIN_COLUMN_CLASS,
  SECTION_STACK_CLASS,
  SIDEBAR_COLUMN_CLASS,
  fillLastRowSpan,
  lastTileSpanClass,
} from "./dashboard-layout";

const css = readFileSync(resolve(__dirname, "../app/globals.css"), "utf-8");
const dashboard = readFileSync(
  resolve(__dirname, "../app/[location]/WeatherDashboard.tsx"),
  "utf-8",
);

describe("fillLastRowSpan", () => {
  it("returns 1 when the last row is already full", () => {
    expect(fillLastRowSpan(4, 4)).toBe(1);
    expect(fillLastRowSpan(8, 4)).toBe(1);
    expect(fillLastRowSpan(4, 2)).toBe(1);
  });

  it("spans the remaining columns when the last row is short", () => {
    expect(fillLastRowSpan(3, 4)).toBe(2); // 3 tiles: last spans 2 → full row
    expect(fillLastRowSpan(5, 4)).toBe(4); // lone tile on its own row
    expect(fillLastRowSpan(6, 4)).toBe(3);
    expect(fillLastRowSpan(5, 2)).toBe(2);
  });

  it("is safe for empty, single-column and non-finite input", () => {
    expect(fillLastRowSpan(0, 4)).toBe(1);
    expect(fillLastRowSpan(3, 1)).toBe(1);
    expect(fillLastRowSpan(Number.NaN, 4)).toBe(1);
  });

  it("always fills the row: (count - 1) % cols + span === cols", () => {
    for (let cols = 2; cols <= 4; cols++) {
      for (let n = 1; n <= 12; n++) {
        const span = fillLastRowSpan(n, cols);
        if (n % cols === 0) expect(span).toBe(1);
        else expect(((n - 1) % cols) + span).toBe(cols);
      }
    }
  });
});

describe("lastTileSpanClass (2 columns mobile / 4 on lg)", () => {
  it("emits nothing when both layouts already fill their rows", () => {
    expect(lastTileSpanClass(4)).toBe("");
    expect(lastTileSpanClass(8)).toBe("");
  });

  it("spans the lone fifth tile across both layouts and drops the square aspect", () => {
    const cls = lastTileSpanClass(5);
    expect(cls).toContain("col-span-2");
    expect(cls).toContain("lg:col-span-4");
    expect(cls).toContain("[&>section]:aspect-auto");
  });

  it("resets the mobile span on lg when the lg row is already full", () => {
    // 6 tiles: mobile rows are full (no span), lg needs the last to span 3.
    expect(lastTileSpanClass(6)).toBe(
      "lg:col-span-3 lg:[&>section]:aspect-auto",
    );
  });
});

describe("one spacing scale", () => {
  it("defines the rhythm tokens in globals.css", () => {
    expect(css).toMatch(/--space-section:\s*1rem/);
    expect(css).toMatch(/--space-stack:\s*0\.75rem/);
    expect(css).toMatch(/--space-card:\s*1rem/);
    expect(css).toMatch(/--space-section:\s*1\.5rem/); // lg step
    expect(css).toMatch(/--space-card:\s*1\.25rem/); // sm step
  });

  it("card surfaces take their padding from --space-card", () => {
    for (const fauna of [".baobab {", ".acacia {", ".pangolin {"]) {
      const rule = css.slice(css.indexOf(fauna));
      expect(rule.slice(0, rule.indexOf("}"))).toContain(
        "p-[var(--space-card)]",
      );
    }
  });

  it("both dashboard columns stack sections one --space-section apart", () => {
    expect(SECTION_STACK_CLASS).toBe("herd");
    const herd = css.slice(css.indexOf(".herd {"));
    expect(herd.slice(0, herd.indexOf("}"))).toContain(
      "gap-[var(--space-section)]",
    );
    // An empty lazy slot (card rendered nothing) can't leave a doubled gap.
    expect(css).toContain(
      '.herd > [data-lazy-section]:not(:has(section, [role="status"]))',
    );
    expect(MAIN_COLUMN_CLASS).toContain(SECTION_STACK_CLASS);
    expect(SIDEBAR_COLUMN_CLASS).toContain(SECTION_STACK_CLASS);
    expect(dashboard).toContain(
      'className="grid gap-[var(--space-section)] lg:grid-cols-3 xl:grid-cols-4"',
    );
  });

  it("the model comparison and nowcast close the main column (no dead band)", () => {
    const sidebarAt = dashboard.indexOf("{/* Sidebar");
    expect(dashboard.indexOf('label="model-comparison"')).toBeLessThan(
      sidebarAt,
    );
    expect(dashboard.indexOf('label="minutely-nowcast"')).toBeLessThan(
      sidebarAt,
    );
  });

  it("the hero sits one --space-section below the breadcrumb", () => {
    expect(dashboard).toContain("pt-[var(--space-section)]");
  });

  it("the About card's coordinates use the shared value style, not mono", () => {
    expect(dashboard).not.toContain('<span className="font-mono text-base">');
  });
});
