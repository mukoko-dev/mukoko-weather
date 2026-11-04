/**
 * Mzizi surface guard — radius and border rules for CARD surfaces, not just
 * buttons.
 *
 * Why this exists (owner report 2026-10-17, /locations screenshot): the MY
 * LOCATION card had square corners and a thick left-only purple border while
 * its sibling saved cards were rounded with a faint left border. Two root
 * causes, both invisible to mzizi-alignment.test.ts:
 *   1. That test only reads `<button` / `role="button"` tags. Cards are
 *      `div`, `Link` and `section`, so no card was ever inspected.
 *   2. Its radius allow-list trusted the NAMES `rounded-card`,
 *      `rounded-button` and `rounded-badge`, but --radius-card & co. are
 *      :root variables that were never registered in the `@theme` block, so
 *      Tailwind generates nothing for those utilities: the element silently
 *      has no radius. A name on a list is not proof the class exists.
 * The rules below are checked over every TSX/CSS file for any element.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const css = readFileSync(join(ROOT, "src/app/globals.css"), "utf-8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(name) && !name.endsWith(".test.ts"))
      out.push(full);
  }
  return out;
}

const SOURCES = walk(join(ROOT, "src"))
  .filter((f) => !f.includes("/api/og/") && !f.includes("weather-scenes"))
  .map((f) => ({ file: relative(ROOT, f), src: readFileSync(f, "utf-8") }));

/** The `@theme` blocks, where utility-generating variables live. */
const themeBlocks = [...css.matchAll(/@theme[^{]*\{([\s\S]*?)\n\}/g)]
  .map((m) => m[1])
  .join("\n");

describe("radius shorthands must exist before they are used", () => {
  for (const name of ["card", "button", "badge", "input"]) {
    it(`rounded-${name} is only used if --radius-${name} is registered in @theme`, () => {
      const registered = new RegExp(`--radius-${name}\\s*:`).test(themeBlocks);
      if (registered) return;
      const offenders = SOURCES.filter((s) =>
        new RegExp(`\\brounded(-[a-z]{1,2})?-${name}\\b`).test(s.src),
      ).map((s) => s.file);
      const inCss = new RegExp(`@apply[^;]*\\brounded-${name}\\b`).test(css);
      expect({ offenders, inCss }).toEqual({ offenders: [], inCss: false });
    });
  }
});

/** Single-side accent borders are another brand's pattern, not Mzizi's. */
const SIDE_ACCENT =
  /(?<![\w-])(?:[a-z-]+:)*border-[lr](?:-(?!transparent)[\w[\]()/.#-]+)?(?![\w-])/;

/** Files where a side border is structural, not a card accent (with reason). */
const SIDE_BORDER_ALLOWED: Record<string, string> = {
  "src/components/ui/scroll-area.tsx":
    "Radix scrollbar track gutter: border-l/-t with a transparent colour",
};

describe("no single-side accent borders on card surfaces", () => {
  it("no component draws border-l-* / border-r-* (use a full mineral-tinted border)", () => {
    const offenders: string[] = [];
    for (const { file, src } of SOURCES) {
      if (SIDE_BORDER_ALLOWED[file]) continue;
      src.split("\n").forEach((line, i) => {
        if (line.trim().startsWith("*") || line.trim().startsWith("//")) return;
        if (SIDE_ACCENT.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("no component fakes a side stripe with an absolutely-positioned span (owner report 2026-10-31: EdgeTile and RecentReports drew a 4px left rule that border-l tests never saw)", () => {
    const STRIPE =
      /absolute[^"'`]*\binset-y-0\b[^"'`]*\b(?:left|right|start|end)-0\b|absolute[^"'`]*\b(?:left|right|start|end)-0\b[^"'`]*\binset-y-0\b/;
    const offenders: string[] = [];
    for (const { file, src } of SOURCES) {
      src.split("\n").forEach((line, i) => {
        if (line.trim().startsWith("*") || line.trim().startsWith("//")) return;
        if (STRIPE.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("globals.css has no left/right-only border on a card class", () => {
    expect(css).not.toMatch(/border-(left|right)(-width|-color)?\s*:/);
    expect(css).not.toMatch(/@apply[^;]*border-[lr]-/);
  });

  it("CategoryStyle carries no leading-edge accent field", () => {
    const acts = SOURCES.find((s) => s.file === "src/lib/activities.ts")!.src;
    expect(acts).not.toContain("borderAccent");
  });
});

describe("the card edge: one rule, tokens only", () => {
  const edgeList = css.match(
    /--card-border-width: var\(--border-width-rest\);/,
  );
  const listMatch = css.match(
    /:is\(\s*((?:\.[a-z-]+(?:,\s*)?)+)\s*\)\s*\{\s*--card-border-width: var\(--border-width-rest\)/,
  );
  const edgeClasses = listMatch
    ? [...listMatch[1].matchAll(/\.([a-z-]+)/g)].map((m) => m[1])
    : [];

  it("defines 0.5px at rest and 1px active as tokens", () => {
    expect(css).toMatch(/--border-width-rest:\s*0\.5px/);
    expect(css).toMatch(/--border-width-active:\s*1px/);
    expect(edgeList).not.toBeNull();
  });

  it("draws a solid border on all four sides from the token", () => {
    expect(css).toMatch(
      /border-style: solid;\s*border-width: var\(--card-border-width\);/,
    );
  });

  it("goes to the active width on hover, aria state and focus-visible", () => {
    for (const hook of [
      ":hover",
      '[aria-current]:not([aria-current="false"])',
      '[aria-pressed="true"]',
      '[aria-selected="true"]',
      ":focus-visible",
    ]) {
      expect(css).toContain(hook);
    }
    expect(css).toMatch(/--card-border-width: var\(--border-width-active\)/);
  });

  it("keeps borders visible in forced-colors and high-contrast modes", () => {
    const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
    expect(forced).toMatch(/--border-width-rest:\s*1px/);
    const contrast = css.slice(css.indexOf("@media (prefers-contrast: more)"));
    expect(contrast).toMatch(/--border-width-rest:\s*1px/);
  });

  it("every card surface class in globals.css joins the edge list", () => {
    // A card surface = a fauna class that paints a card radius AND a border.
    const blocks = [...css.matchAll(/\n  \.([a-z-]+)\s*\{([^}]*)\}/g)];
    const cards = blocks
      .filter(
        ([, , body]) =>
          /rounded-\[var\(--radius-card\)\]|border-radius:\s*var\(--radius-card\)/.test(
            body,
          ) &&
          /(?<![\w-])border(?![\w-])|(?<![\w-])border-(?!radius)[a-z]/.test(
            body,
          ),
      )
      .map(([, name]) => name)
      // .ledger-style inner dividers etc. are not card surfaces
      .filter((n) => !["guineafowl-heading", "guineafowl-row"].includes(n));
    const missing = cards.filter(
      (n) => !edgeClasses.includes(n) && n !== "bushbuck",
    );
    expect(missing).toEqual([]);
    for (const n of [
      "baobab",
      "acacia",
      "guineafowl-card",
      "chameleon",
      "nyala",
    ]) {
      expect(edgeClasses).toContain(n);
    }
  });

  it("the location tile and place rows use the shared classes, not their own borders", () => {
    const tile = SOURCES.find(
      (s) => s.file === "src/components/weather/LocationWeatherCard.tsx",
    )!.src;
    expect(tile).toContain("nyala");
    expect(tile).not.toMatch(/rounded-card|border-l/);
    const modal = SOURCES.find(
      (s) => s.file === "src/components/weather/MyWeatherModal.tsx",
    )!.src;
    expect(modal).toContain("bushbuck");
  });
});

describe("saved-location surfaces use radius TOKENS only", () => {
  const SURFACES = [
    "src/components/weather/LocationWeatherCard.tsx",
    "src/components/weather/MyWeatherModal.tsx",
    "src/components/weather/LocationPromptCard.tsx",
    "src/components/layout/PlaceLane.tsx",
    "src/components/ui/mzizi-bottom-nav.tsx",
    "src/app/locations/LocationsClient.tsx",
    "src/app/locations/LocationsMenu.tsx",
    "src/app/locations/LocationsSearch.tsx",
  ];
  const OK =
    /^rounded(?:-[a-z]{1,2})?-(?:full|none|\[var\(--radius-[a-z-]+\)\])$/;

  it("every rounded-* utility is full, none or a --radius-* token", () => {
    const offenders: string[] = [];
    for (const f of SURFACES) {
      const src = SOURCES.find((s) => s.file === f)!.src.replace(
        /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm,
        "",
      );
      for (const m of src.matchAll(/[\w:-]*\brounded(?:-[\w[\]()-]+)?/g)) {
        const t = m[0].split(":").pop()!;
        if (!t.startsWith("rounded")) continue;
        if (!OK.test(t)) offenders.push(`${f}: ${t}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("menus inside a card use --radius-sm rows (smaller than the container)", () => {
    for (const f of [
      "src/app/locations/LocationsMenu.tsx",
      "src/app/locations/LocationsSearch.tsx",
      "src/components/weather/LocationWeatherCard.tsx",
    ]) {
      const src = SOURCES.find((s) => s.file === f)!.src;
      expect(src, f).not.toMatch(/rounded-\[var\(--radius-button\)\] px-3 py-/);
      expect(src, f).toContain("rounded-[var(--radius-sm)]");
    }
  });
});

/* ---------------------------------------------------------------------------
 * One set of corners: every radius in src is a Mzizi token.
 *
 * Owner report 2026-11-04: "we use different types of components, different
 * radius and different things". The repo's rule was already "only
 * `rounded-full`, `rounded-none` or `rounded-[var(--radius-*)]`", but the
 * guard above read eight files, so the rest of src drifted:
 *   - bare `rounded` (Tailwind's own 0.25rem, 4px) and `rounded-xs`
 *     (--radius-xs, 2px) come from Tailwind's default theme and are NOT on the
 *     Mzizi scale;
 *   - `rounded-sm|md|lg|xl|2xl` DO resolve to the Mzizi scale (7/12/14/17px
 *     through the `@theme` block), but under a size word, not a role, so the
 *     same card ended up as `rounded-lg` here and `--radius-card` there;
 *   - a literal radius (`rounded-[6px]`, `border-radius: 4px`) is its own
 *     number.
 * A role token (`--radius-card`, `--radius-input`, `--radius-badge`,
 * `--radius-button`, `--radius-sm`, `--radius-full`) is the only form allowed,
 * so changing a token moves every consumer and nothing is left behind.
 *
 * How it reads the code: class names are found in STRING LITERALS (the
 * TypeScript parser, so a comment or the word "rounded" in JSX text is never
 * mistaken for a class), `@apply` lines and `border-radius` declarations in
 * CSS, and `borderRadius` style properties. SVG `rx` attributes are icon
 * geometry, not a surface radius, and are not read.
 * ------------------------------------------------------------------------ */

/** A `rounded*` utility: bare, with a size word, a side, or an arbitrary value. */
const RADIUS_UTILITY =
  /(?<![\w-])rounded(?:-(?:s|e|t|r|b|l|ss|se|ee|es|tl|tr|br|bl))?(?:-(?:\[[^\]\s"'`]*\]|[a-z0-9]+))?(?![\w-])/g;

/** The only forms allowed: full, none, a --radius-* token, or `inherit`. */
const RADIUS_UTILITY_OK =
  /^rounded(?:-(?:s|e|t|r|b|l|ss|se|ee|es|tl|tr|br|bl))?-(?:full|none|\[(?:var\(--radius-[a-z0-9-]+\)|inherit)\])$/;

/** `rounded*` utilities in `text` that are not an allowed form. */
function offendingRadiusUtilities(text: string): string[] {
  return [...text.matchAll(RADIUS_UTILITY)]
    .map((m) => m[0])
    .filter((token) => !RADIUS_UTILITY_OK.test(token));
}

/** A CSS radius value that names a token (or inherits, or is zero). */
const CSS_RADIUS_VALUE_OK =
  /^(?:var\(--radius-[a-z0-9-]+\)|inherit|initial|unset|0)$/;

const CSS_RADIUS_DECLARATION =
  /(?<![\w-])border(?:-(?:top|bottom)-(?:left|right)|-(?:start|end)-(?:start|end))?-radius\s*:\s*([^;}]+)/g;

/** Off-token radii in a CSS source (comments are blanked first). */
function offendingCssRadii(source: string): string[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  const out: string[] = [];
  for (const m of text.matchAll(CSS_RADIUS_DECLARATION)) {
    const value = m[0].slice(m[0].indexOf(":") + 1).trim();
    if (!CSS_RADIUS_VALUE_OK.test(value)) {
      out.push(`${m[0].slice(0, m[0].indexOf(":")).trim()}: ${value}`);
    }
  }
  for (const m of text.matchAll(/@apply\s+([^;}]+)/g)) {
    out.push(...offendingRadiusUtilities(m[1]));
  }
  return out;
}

const STYLE_RADIUS_KEY =
  /^border(?:(?:Top|Bottom)(?:Left|Right))?Radius$|^border(?:Start|End)(?:Start|End)Radius$/;

/** Off-token radii in a TS/TSX source: class strings and style properties. */
function offendingSourceRadii(file: string, text: string): string[] {
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const parent = node.parent;
      // Module specifiers are paths, not classes.
      const isModulePath =
        ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent);
      if (!isModulePath) {
        for (const token of offendingRadiusUtilities(node.text)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
          out.push(`${line + 1}: ${token}`);
        }
      }
    } else if (ts.isPropertyAssignment(node)) {
      const name = node.name;
      const key =
        ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : "";
      if (STYLE_RADIUS_KEY.test(key)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        out.push(`${line + 1}: ${key}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function walkFiles(dir: string, match: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkFiles(full, match, out);
    else if (match.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Places that genuinely cannot name a token, each with the exact number of
 * off-token radii it may hold (a new one fails, and so does a stale entry).
 */
const RADIUS_ALLOWED: Record<string, { count: number; reason: string }> = {
  "src/components/embed/MukokoWeatherEmbed.module.css": {
    count: 1,
    reason:
      "self-contained embed widget CSS for third-party pages: it carries its own --mkw-* variables and none of the app's tokens",
  },
  "src/app/aviation/AviationBriefingPDF.tsx": {
    count: 6,
    reason:
      "@react-pdf/renderer StyleSheet: numeric points, and react-pdf cannot read CSS variables (the same reason FLIGHT_CATEGORY_PDF exists)",
  },
  "src/components/weather/charts/TimeSeriesChart.tsx": {
    count: 1,
    reason:
      "Chart.js bar corner, drawn on a canvas: a number in chart options, not a CSS radius",
  },
  "src/app/api/og/route.tsx": {
    count: 6,
    reason:
      "next/og (Satori) renders inline styles to an image, with no CSS variables or Tailwind (documented exception in CLAUDE.md)",
  },
};

describe("every radius in src is a Mzizi token", () => {
  const sourceFiles = walkFiles(join(ROOT, "src"), /\.tsx?$/).filter(
    (f) => !f.endsWith(".d.ts"),
  );
  const cssFiles = walkFiles(join(ROOT, "src"), /\.css$/);

  /** file -> off-token radii found in it. */
  const found = new Map<string, string[]>();
  for (const f of sourceFiles) {
    const hits = offendingSourceRadii(f, readFileSync(f, "utf-8"));
    if (hits.length) found.set(relative(ROOT, f), hits);
  }
  for (const f of cssFiles) {
    const hits = offendingCssRadii(readFileSync(f, "utf-8"));
    if (hits.length) found.set(relative(ROOT, f), hits);
  }

  it("no class, @apply, border-radius or style property outside the allow-list names a size instead of a token", () => {
    const offenders = [...found]
      .filter(([file]) => !RADIUS_ALLOWED[file])
      .map(([file, hits]) => `${file} -> ${hits.join(" | ")}`);
    expect(offenders).toEqual([]);
  });

  it("the allow-list is exact: every entry still exists and holds exactly its count", () => {
    const drift: string[] = [];
    for (const [file, { count, reason }] of Object.entries(RADIUS_ALLOWED)) {
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(20);
      const actual = found.get(file)?.length ?? 0;
      if (actual !== count) {
        drift.push(`${file}: expected ${count}, found ${actual}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it("every --radius-* a class or declaration names is defined", () => {
    const tokensCss = readFileSync(
      join(ROOT, "src/app/mzizi-tokens.css"),
      "utf-8",
    );
    const defined = new Set(
      [...`${css}\n${tokensCss}`.matchAll(/(--radius-[a-z0-9-]+)\s*:/g)].map(
        (m) => m[1],
      ),
    );
    const used = new Map<string, string>();
    const note = (file: string, text: string) => {
      for (const m of text.matchAll(/var\((--radius-[a-z0-9-]+)\)/g)) {
        if (!used.has(m[1])) used.set(m[1], file);
      }
    };
    for (const f of sourceFiles) {
      const rel = relative(ROOT, f);
      const sf = ts.createSourceFile(
        f,
        readFileSync(f, "utf-8"),
        ts.ScriptTarget.Latest,
        true,
        f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visit = (n: ts.Node) => {
        if (
          ts.isStringLiteralLike(n) ||
          ts.isTemplateHead(n) ||
          ts.isTemplateMiddle(n) ||
          ts.isTemplateTail(n)
        ) {
          note(rel, n.text);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    for (const f of cssFiles) note(relative(ROOT, f), readFileSync(f, "utf-8"));
    const undefinedVars = [...used]
      .filter(([name]) => !defined.has(name))
      .map(([name, file]) => `${name} (first used in ${file})`);
    expect(undefinedVars).toEqual([]);
  });

  describe("the matcher itself", () => {
    it("refuses a bare radius, a size word, a side and a literal size", () => {
      for (const cls of [
        "rounded",
        "rounded-xs",
        "rounded-sm",
        "rounded-md",
        "rounded-lg",
        "rounded-xl",
        "rounded-2xl",
        "rounded-3xl",
        "rounded-t",
        "rounded-t-lg",
        "rounded-tl-md",
        "rounded-[4px]",
        "rounded-[0.5rem]",
        "rounded-t-[12px]",
        "hover:rounded",
        "focus-visible:rounded",
        "sm:rounded-md",
        "[&>svg]:rounded-lg",
      ]) {
        expect(offendingRadiusUtilities(`flex ${cls} p-2`), cls).toEqual([
          cls.split(":").pop(),
        ]);
      }
    });

    it("accepts full, none, a --radius-* token and inherit, with any variant", () => {
      for (const cls of [
        "rounded-full",
        "rounded-none",
        "rounded-[var(--radius-card)]",
        "rounded-[var(--radius-sm)]",
        "rounded-t-[var(--radius-card)]",
        "sm:rounded-[var(--radius-card)]",
        "focus-visible:rounded-[var(--radius-sm)]",
        "rounded-[inherit]",
        "rounded-l-none",
      ]) {
        expect(offendingRadiusUtilities(`flex ${cls} p-2`), cls).toEqual([]);
      }
    });

    it("reads class strings, not prose, comments or JSX text", () => {
      const src = [
        "// a bare rounded corner in a comment",
        "/** rounded-lg in a doc comment */",
        'export const note = "unrelated";',
        "export function A() {",
        "  return <p>coordinates rounded to four decimals</p>;",
        "}",
      ].join("\n");
      expect(offendingSourceRadii("a.tsx", src)).toEqual([]);
      const bad = 'export const a = <div className="flex rounded p-2" />;';
      expect(offendingSourceRadii("a.tsx", bad)).toEqual(["1: rounded"]);
      const tpl = "export const b = `inline-flex ${x} rounded-md`;";
      expect(offendingSourceRadii("b.ts", tpl)).toEqual(["1: rounded-md"]);
      const style = "export const s = { borderRadius: 4 };";
      expect(offendingSourceRadii("s.ts", style)).toEqual(["1: borderRadius"]);
    });

    it("reads CSS declarations and @apply, not comments or token definitions", () => {
      const cssText = [
        "/* border-radius: 4px in a comment, @apply rounded */",
        ":root { --radius-card: 14px; --radius-sky-card: 1.375rem; }",
        ".a { border-radius: var(--radius-card); }",
        ".b { border-radius: 9999px; }",
        ".c { border-radius: inherit; }",
        ".d { @apply rounded-full rounded-[var(--radius-sm)]; }",
        ".e { @apply rounded; }",
        ".f { border-top-left-radius: 4px; }",
      ].join("\n");
      expect(offendingCssRadii(cssText)).toEqual([
        "border-radius: 9999px",
        "border-top-left-radius: 4px",
        "rounded",
      ]);
    });
  });
});
