/**
 * Mzizi alignment guard — every interactive control in the app is either the
 * shared Button primitive (src/components/ui/button.tsx, which implements the
 * Mzizi Button contract: pill radius, 48px floor) or composes one of the
 * fauna control classes defined in globals.css. Hand-rolled buttons with
 * their own border/radius chains are how a rectangular "Pick activities" box
 * reached production; this test stops that from happening again.
 *
 * What it enforces, for every `<button` and `role="button"` element in
 * src/components/** and src/app/** (TSX, tests and the ui/ primitives
 * themselves excluded):
 *   1. Its className composes a fauna control class (CONTROL_CLASSES), or the
 *      file carries an explicit, reasoned exception in ALLOWED_EXCEPTIONS —
 *      a per-file COUNT, so adding a new rogue button to an excepted file
 *      still fails.
 *   2. It never uses a hardcoded Tailwind radius (`rounded`, `rounded-md`,
 *      `rounded-lg`, `rounded-[6px]`, …). Radii come from tokens:
 *      rounded-full / rounded-none / rounded-button / rounded-card or
 *      rounded-[var(--radius-*)]. This rule has no exceptions.
 *
 * `<Button` (the primitive) is never matched — JSX is case-sensitive.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const SCAN_DIRS = ["src/components", "src/app"];

/** Fauna classes that ARE Mzizi-aligned controls (see globals.css). */
export const CONTROL_CLASSES = new Set([
  // Pill buttons (Mzizi Button: default / outline variants)
  "kudu",
  "kudu-sm",
  "kudu-plate",
  "impala",
  "impala-sm",
  "impala-primary",
  "impala-plate",
  // Round icon button
  "bee",
  // Pill chip / toggle chip (aria-pressed)
  "quail",
  // Inline text actions and nav links (Mzizi Button `link` variant)
  "dikdik",
  "dik-dik",
  "weaver",
  "weaver-active",
]);

/**
 * Buttons that are legitimately not pills — list rows, menu items, tabs,
 * map zoom controls, drag handles — counted per file, each with a reason.
 */
const ALLOWED_EXCEPTIONS: Record<string, { count: number; reason: string }> = {
  "src/components/layout/Header.tsx": {
    count: 2,
    reason: "mobile ⋯ menu item rows (MENU_ITEM_CLASS) — menu, not a button",
  },
  "src/app/locations/LocationsMenu.tsx": {
    count: 2,
    reason: "dropdown menu item rows (itemClass)",
  },
  "src/app/[location]/map/MapDashboard.tsx": {
    count: 2,
    reason: "map zoom +/− segmented control (stacked square segments)",
  },
  "src/components/weather/DraggableSection.tsx": {
    count: 1,
    reason: "reorder drag handle — round grip, only shown while reordering",
  },
  "src/components/weather/CommunityLane.tsx": {
    count: 1,
    reason: "report pin on the 24h lane — round marker, positioned on a track",
  },
  "src/components/weather/LocationPromptCard.tsx": {
    count: 1,
    reason: "round dismiss (×) icon control",
  },
  "src/app/profile/ProfileClient.tsx": {
    count: 1,
    reason:
      "Preferences settings-list row (.guineafowl-row) — list row, not a pill",
  },
  "src/components/profile/ProfileAppearance.tsx": {
    count: 1,
    reason:
      "Light/Dark/System option tiles (role=radio) — radio cards, not pills",
  },
  "src/components/profile/ProfileIdentity.tsx": {
    count: 1,
    reason: "round edit (pencil) icon control beside the profile name",
  },
  "src/components/weather/LocationWeatherCard.tsx": {
    count: 2,
    reason:
      "card ⋯ menu item rows and the round remove (−) badge on an edited card",
  },
  "src/components/weather/AISummaryChat.tsx": {
    count: 1,
    reason: "full-width disclosure header row of the chat card",
  },
  "src/components/weather/MyWeatherModal.tsx": {
    count: 6,
    reason:
      "selectable list rows and tiles: location rows, activity tiles, theme and forecast-model radio cards",
  },
  "src/components/weather/reports/WeatherReportModal.tsx": {
    count: 2,
    reason: "report-type tiles and severity segmented options (wizard)",
  },
  "src/components/explore/ExploreChatbot.tsx": {
    count: 1,
    reason: "round scroll-to-bottom floating control",
  },
  "src/app/aviation/AviationPlanner.tsx": {
    count: 3,
    reason: "station-chip remove ×, search result rows, inline text link",
  },
  "src/app/history/HistoryDashboard.tsx": {
    count: 4,
    reason: "search result rows and period segmented control",
  },
  "src/app/locations/LocationsSearch.tsx": {
    count: 1,
    reason: "search result rows",
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** Returns the full opening tag that starts at `start` (`<`…`>`). */
export function openingTagAt(src: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** Every class-like token in a tag's className expression. */
export function classTokens(tag: string): string[] {
  const at = tag.indexOf("className=");
  if (at === -1) return [];
  const rest = tag.slice(at + "className=".length);
  let expr = rest;
  if (rest.startsWith('"')) {
    expr = rest.slice(1, rest.indexOf('"', 1));
  } else if (rest.startsWith("{")) {
    let depth = 0;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "{") depth++;
      else if (rest[i] === "}" && --depth === 0) {
        expr = rest.slice(1, i);
        break;
      }
    }
  }
  // Split on whitespace, quotes and braces only — never inside a token, so
  // `rounded-[var(--radius-card)]` survives intact — then drop the leftover
  // JS punctuation (`cn(`, `,`, `?`, `:`, `${`).
  return expr
    .split(/[\s"'`{}]+/)
    .map((t) => t.replace(/^!/, "").replace(/,$/, ""))
    .filter((t) => /^[a-z[-]/.test(t) && !t.endsWith("("));
}

/** Strip Tailwind variant prefixes: `hover:sm:rounded-lg` → `rounded-lg`. */
function baseUtility(token: string): string {
  // Split on ":" outside brackets.
  let depth = 0;
  let last = 0;
  for (let i = 0; i < token.length; i++) {
    if (token[i] === "[") depth++;
    else if (token[i] === "]") depth--;
    else if (token[i] === ":" && depth === 0) last = i + 1;
  }
  return token.slice(last);
}

const ALLOWED_RADIUS =
  /^rounded(?:-[a-z]{1,2})?-(?:full|none|button|card|badge|\[var\(--radius-[a-z-]+\)\])$/;

/** True when the token is a hardcoded (non-token) Tailwind radius. */
export function isHardcodedRadius(token: string): boolean {
  const u = baseUtility(token);
  if (!/^rounded(?:$|-)/.test(u)) return false;
  return !ALLOWED_RADIUS.test(u);
}

/** True when the tokens compose a Mzizi-aligned control class. */
export function usesControlClass(tokens: string[]): boolean {
  return tokens.some((t) => CONTROL_CLASSES.has(t));
}

interface Found {
  file: string;
  line: number;
  tag: string;
}

function collect(): Found[] {
  const found: Found[] = [];
  for (const dir of SCAN_DIRS) {
    for (const full of walk(join(ROOT, dir))) {
      const file = relative(ROOT, full);
      if (file.startsWith("src/components/ui/")) continue; // the primitives
      const src = readFileSync(full, "utf-8");
      const starts = new Set<number>();
      for (const m of src.matchAll(/<button\b/g)) starts.add(m.index!);
      for (const m of src.matchAll(/role="button"/g)) {
        starts.add(src.lastIndexOf("<", m.index!));
      }
      for (const start of starts) {
        found.push({
          file,
          line: src.slice(0, start).split("\n").length,
          tag: openingTagAt(src, start),
        });
      }
    }
  }
  return found;
}

const FOUND = collect();

describe("Mzizi alignment guard — helpers", () => {
  it("reads a multi-line opening tag with arrow functions inside braces", () => {
    const src = `<button onClick={() => go(1)} className="kudu-sm">x</button>`;
    expect(openingTagAt(src, 0)).toBe(
      `<button onClick={() => go(1)} className="kudu-sm">`,
    );
  });

  it("splits string, template and cn() classNames into tokens", () => {
    expect(classTokens(`<b className="kudu mt-4">`)).toEqual(["kudu", "mt-4"]);
    expect(
      classTokens('<b className={cn("quail", on ? `a` : "b")}>'),
    ).toContain("quail");
  });

  it("flags hardcoded radii but allows token radii", () => {
    for (const bad of [
      "rounded",
      "rounded-md",
      "rounded-lg",
      "hover:rounded-xl",
      "rounded-[6px]",
      "rounded-t-lg",
    ]) {
      expect(isHardcodedRadius(bad)).toBe(true);
    }
    for (const ok of [
      "rounded-full",
      "rounded-none",
      "rounded-button",
      "rounded-card",
      "rounded-[var(--radius-button)]",
      "rounded-[var(--radius-input)]",
      "sm:rounded-full",
      "mt-4",
    ]) {
      expect(isHardcodedRadius(ok)).toBe(false);
    }
  });

  it("finds the buttons in the codebase (the scan is not vacuous)", () => {
    expect(FOUND.length).toBeGreaterThan(40);
  });
});

describe("Mzizi alignment guard — every button", () => {
  it("never hardcodes a Tailwind radius on a button", () => {
    const offenders = FOUND.filter((f) =>
      classTokens(f.tag).some(isHardcodedRadius),
    ).map((f) => `${f.file}:${f.line}`);
    expect(offenders).toEqual([]);
  });

  it("composes a Mzizi control class, or is a counted, reasoned exception", () => {
    const perFile = new Map<string, string[]>();
    for (const f of FOUND) {
      if (usesControlClass(classTokens(f.tag))) continue;
      perFile.set(f.file, [...(perFile.get(f.file) ?? []), String(f.line)]);
    }
    const problems: string[] = [];
    for (const [file, lines] of perFile) {
      const allowed = ALLOWED_EXCEPTIONS[file]?.count ?? 0;
      if (lines.length > allowed) {
        problems.push(
          `${file}: ${lines.length} non-Mzizi button(s) at lines ${lines.join(", ")} (allowed ${allowed}) — use <Button> or a fauna control class`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it("keeps the exception list honest (no stale or reasonless entries)", () => {
    for (const [file, { count, reason }] of Object.entries(
      ALLOWED_EXCEPTIONS,
    )) {
      expect(reason.length, file).toBeGreaterThan(10);
      const actual = FOUND.filter(
        (f) => f.file === file && !usesControlClass(classTokens(f.tag)),
      ).length;
      expect(actual, `${file} exception count`).toBe(count);
    }
  });

  it("the hero plate CTA and Share are Mzizi pills", () => {
    const hero = FOUND.filter((f) => f.file.endsWith("CurrentConditions.tsx"));
    expect(hero.length).toBe(2);
    for (const f of hero) {
      expect(
        classTokens(f.tag).some(
          (t) => t === "kudu-plate" || t === "impala-plate",
        ),
      ).toBe(true);
    }
  });
});
