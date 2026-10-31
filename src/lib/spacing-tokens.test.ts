/**
 * Spacing guard for the location page and its sections.
 *
 * One spacing scale (globals.css):
 *   --space-section  between sections (the .herd gap)
 *   --space-stack    heading-to-card and card-to-card inside a section
 *   --space-card     padding inside every card (.baobab / .acacia / .pangolin)
 *
 * v0.10.0 shipped cards that touched, cards narrower than their column and
 * hand-picked padding (p-5 sm:p-6, p-3.5, pb-24) because sections could
 * bypass the tokens. This test fails when one does.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, resolve } from "path";

const SRC = resolve(__dirname, "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".tsx") && !p.endsWith(".test.tsx")) out.push(p);
  }
  return out;
}

/** Every section of the location page and the location sub-routes. */
const FILES = [
  ...walk(join(SRC, "components/weather")),
  ...walk(join(SRC, "app/[location]")),
];

const rel = (p: string) => relative(SRC, p);

/**
 * Card surfaces that deliberately use a denser padding than --space-card.
 * Each entry is a file and the exact padding class, with the reason.
 */
const DENSE_CARD_EXCEPTIONS: Record<string, { padding: string; why: string }> =
  {
    "components/weather/MetricCard.tsx": {
      padding: "p-3",
      why: "small gauge tile in a 2/4-column grid",
    },
    "components/weather/HourlyScrollCards.tsx": {
      padding: "p-3",
      why: "frame of a horizontally scrolling hour strip",
    },
    "components/weather/LocationSkeleton.tsx": {
      padding: "p-3",
      why: "mirrors the hour-strip frame so the skeleton has the same box",
    },
  };

const CARD_WITH_PADDING =
  /\b(baobab|acacia|pangolin)\b[^"`]*?\s((?:sm:|md:|lg:)?p[xytblr]?-(?!0\b)(?!\[var\()[0-9.]+)\b/g;

describe("cards take their padding from --space-card", () => {
  it("no card surface overrides its padding with a hand-picked value", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf-8");
      for (const m of src.matchAll(CARD_WITH_PADDING)) {
        const allowed = DENSE_CARD_EXCEPTIONS[rel(file)];
        if (allowed && allowed.padding === m[2]) continue;
        offenders.push(`${rel(file)}: "${m[1]} … ${m[2]}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every dense-card exception still exists (no stale allowances)", () => {
    for (const [file, { padding }] of Object.entries(DENSE_CARD_EXCEPTIONS)) {
      const src = readFileSync(join(SRC, file), "utf-8");
      expect(src, file).toMatch(
        new RegExp(`\\b(baobab|acacia|pangolin)\\b[^"\`]*\\s${padding}\\b`),
      );
    }
  });

  it("the shared error fallback uses the card padding token", () => {
    const src = readFileSync(
      join(SRC, "components/weather/ChartErrorBoundary.tsx"),
      "utf-8",
    );
    expect(src).toContain("p-[var(--space-card)]");
  });
});

describe("headings sit one --space-stack above their cards", () => {
  it("no SectionHeader on a section uses a hand-picked bottom margin", () => {
    const offenders: string[] = [];
    const re = /<SectionHeader[\s\S]*?\/>/g;
    for (const file of FILES) {
      const src = readFileSync(file, "utf-8");
      for (const m of src.matchAll(re)) {
        if (/className="[^"]*\bmb-[0-9]/.test(m[0])) {
          offenders.push(rel(file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("pages clear the mobile nav with the token, not a guess", () => {
  it("no location page or skeleton uses pb-20/pb-24/pb-28 for nav clearance", () => {
    const offenders = FILES.filter((f) =>
      /\bpb-(20|24|28)\b/.test(readFileSync(f, "utf-8")),
    ).map(rel);
    expect(offenders).toEqual([]);
  });
});

describe("the location dashboard spaces sections with tokens only", () => {
  const dashboard = readFileSync(
    join(SRC, "app/[location]/WeatherDashboard.tsx"),
    "utf-8",
  );

  it("uses no numeric margin utilities (gaps come from .herd / tokens)", () => {
    expect(dashboard.match(/\s-?m[tbxylr]?-[0-9]+\b/g) ?? []).toEqual([]);
  });

  it("both columns are .herd stacks from dashboard-layout", () => {
    expect(dashboard).toContain("MAIN_COLUMN_CLASS");
    expect(dashboard).toContain("SIDEBAR_COLUMN_CLASS");
    expect(dashboard).toContain("SECTION_STACK_CLASS");
    expect(dashboard).toContain("gap-[var(--space-section)]");
  });

  it("every main-column section is a DraggableSection the .herd can drop when empty", () => {
    const draggable = readFileSync(
      join(SRC, "components/weather/DraggableSection.tsx"),
      "utf-8",
    );
    expect(draggable).toContain("data-herd-item={id}");
  });
});

describe(".herd (globals.css) keeps one gap and full-width children", () => {
  const css = readFileSync(join(SRC, "app/globals.css"), "utf-8");
  const herd = css.slice(css.indexOf(".herd {"), css.indexOf(".baobab {"));

  it("gaps sections by --space-section", () => {
    expect(herd).toContain("gap-[var(--space-section)]");
  });

  it("stretches every child to the column width", () => {
    expect(herd).toMatch(/\.herd > \* \{\s*@apply w-full min-w-0;/);
  });

  it("drops empty lazy AND draggable slots, but keeps skeletons and error fallbacks", () => {
    expect(herd).toContain("[data-lazy-section], [data-herd-item]");
    expect(herd).toContain('section, [role="status"], [role="alert"]');
  });

  it("card surfaces pad with --space-card", () => {
    for (const cls of ["baobab", "acacia", "pangolin"]) {
      const block = css.slice(css.indexOf(`.${cls} {`));
      expect(block.slice(0, 220), cls).toContain("p-[var(--space-card)]");
    }
  });
});
