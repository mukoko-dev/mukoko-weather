/**
 * The shared modal and bottom sheet (issue #482): a visible Close at the top of
 * every modal, pull down to dismiss on phones, and corners that follow the
 * screen. The behaviour lives in ONE place (dialog.tsx and sheet-drag.ts), so
 * these tests read that place, and then check that no modal in src/ goes round
 * it. The pull itself is driven in sheet-drag.test.ts (a fake element) and in
 * scripts/browser-check/modal-sheet.mjs (real Chromium).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SHEET_DRAG_ATTRIBUTE } from "@/lib/sheet-drag";

const ROOT = resolve(__dirname, "../../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf-8");
const dialog = read("src/components/ui/dialog.tsx");
const css = read("src/app/globals.css");
const tokens = read("src/app/mzizi-tokens.css");
const dragSource = read("src/lib/sheet-drag.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}
const sources = walk(join(ROOT, "src")).map((file) => ({
  file: relative(ROOT, file),
  src: readFileSync(file, "utf-8"),
}));

/** The value of `--name: ...;` as written in globals.css. */
const token = (name: string) =>
  css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();

/** A rem or px length in px. */
const px = (value: string | undefined) => {
  const m = value?.match(/^([\d.]+)(px|rem)$/);
  if (!m) throw new Error(`not a length: ${value}`);
  return Number(m[1]) * (m[2] === "rem" ? 16 : 1);
};

/** The source of one function in dialog.tsx, up to the next top-level one. */
const fn = (name: string) => {
  const start = dialog.indexOf(`function ${name}(`);
  expect(start, `function ${name}`).toBeGreaterThan(-1);
  const next = dialog.indexOf("\nfunction ", start + 1);
  return dialog.slice(start, next === -1 ? undefined : next);
};

describe("a visible Close at the top of every modal", () => {
  const bar = fn("DialogBar");

  it("DialogContent renders the bar itself, with no switch to leave it out", () => {
    const content = fn("DialogContent");
    expect(content).toContain("<DialogBar");
    // The bar is not behind a prop or a condition: a modal cannot forget it.
    expect(content).not.toMatch(/\{[a-zA-Z]+\s*&&\s*<DialogBar/);
    expect(content).not.toMatch(/hideClose|showClose|withoutClose/);
  });

  it("the control is a labelled Radix Close with the round bordered look", () => {
    expect(bar).toContain("<DialogPrimitive.Close");
    expect(bar).toContain('aria-label="Close"');
    expect(bar).toContain('data-slot="dialog-close"');
    expect(bar).toContain('data-sheet-close=""');
    // .duiker is the 49px round control; the hairline is the float border.
    expect(bar).toContain("duiker");
    expect(bar).toContain("border-[color:var(--float-border)]");
    expect(bar).toContain("border-[length:var(--border-width-rest)]");
    // The icon is decoration: the label names the control.
    expect(bar).toMatch(/<X [^>]*aria-hidden="true"/);
  });

  it("is the 49px hit region of the Bundu floor", () => {
    const duiker = css.match(/\.duiker \{([^}]*)\}/)?.[1] ?? "";
    expect(duiker).toContain("w-[var(--touch-target-min)]");
    expect(duiker).toContain("h-[var(--touch-target-min)]");
    expect(token("--touch-target-min")).toBe("var(--target-floor)");
    expect(token("--target-floor")).toBe("49px");
    // The row that holds it is exactly the hit region tall.
    expect(bar).toContain("h-[var(--touch-target-min)]");
  });

  it("keeps the spacing floor: card inset at the edge, 7px between controls", () => {
    expect(bar).toContain("gap-[var(--gap-floor)]");
    expect(bar).toContain("ps-[var(--space-card)]");
    expect(bar).toContain("pe-[var(--gap-floor)]");
    expect(px(token("--gap-floor"))).toBeGreaterThanOrEqual(7);
  });

  it("is pinned to the top of the scrolling sheet and is the drag handle", () => {
    expect(bar).toContain("sticky top-0");
    expect(bar).toContain("bg-surface-card");
    // The 7px above Close is padding on the bar, not a margin on the row: a
    // margin collapses out of the bar, and a stuck bar lost it (found in the
    // real-browser check when a sheet scrolled to a card on open).
    expect(bar).toContain("pt-[var(--gap-floor)]");
    expect(bar).not.toMatch(/mt-\[var\(--gap-floor\)\] flex h-/);
    // touch-action: none, so a pull on the bar is never taken for a scroll.
    expect(bar).toContain("touch-none");
    expect(bar).toContain(`${SHEET_DRAG_ATTRIBUTE}=""`);
    expect(SHEET_DRAG_ATTRIBUTE).toBe("data-sheet-drag");
  });

  it("the grab pill is decoration with the 3:1 float border colour", () => {
    expect(bar).toContain('aria-hidden="true"');
    expect(bar).toContain("bg-[color:var(--float-border)]");
    expect(bar).toContain("sm:hidden");
  });

  it("the title is the dialog's accessible name and sits beside Close", () => {
    expect(bar).toContain("<DialogTitle");
    expect(bar).toContain("{actions}");
    expect(bar.indexOf("{actions}")).toBeLessThan(
      bar.indexOf("<DialogPrimitive.Close"),
    );
  });

  it("every modal in src goes through the shared DialogContent", () => {
    const users = sources
      .filter(
        (s) =>
          s.file !== "src/components/ui/dialog.tsx" &&
          /<DialogContent\b/.test(s.src),
      )
      .map((s) => s.file)
      .sort();
    // A new modal belongs on this list on purpose: it gets the Close, the pull
    // down and the corners for free, and a test to read here.
    expect(users).toEqual([
      "src/components/ui/detail-sheet.tsx",
      "src/components/weather/AirQualityDetail.tsx",
      "src/components/weather/MyWeatherModal.tsx",
      "src/components/weather/PWAInstallPrompt.tsx",
      "src/components/weather/reports/WeatherReportModal.tsx",
    ]);
    for (const file of users) {
      const src = sources.find((s) => s.file === file)!.src;
      // Each names itself: a pinned heading, or its own DialogTitle.
      expect(
        /heading=[{"]/.test(src) || /<DialogTitle\b/.test(src),
        `${file} names its dialog`,
      ).toBe(true);
      // None keeps the old handle or draws a second, private Close.
      expect(src, file).not.toContain("DialogSheetHandle");
      expect(src, file).not.toContain('aria-label="Close"');
    }
  });

  it("no one else builds a Radix dialog of their own", () => {
    const own = sources
      .filter((s) => /@radix-ui\/react-dialog|from "radix-ui"/.test(s.src))
      .map((s) => s.file);
    expect(own).toEqual(["src/components/ui/dialog.tsx"]);
  });
});

describe("pull down to dismiss, built once", () => {
  const content = fn("DialogContent");

  it("DialogContent attaches the drag to its own node and closes through Close", () => {
    expect(dialog).toContain('from "@/lib/sheet-drag"');
    expect(content).toContain("attachSheetDrag(node");
    // The dismissal is a click on the Close control, so Radix's onOpenChange,
    // focus return and scroll lock run exactly as for a tap on Close.
    // (the bar's own control, not a Close button a modal draws at its foot)
    expect(content).toContain('"[data-sheet-close]"');
    expect(content).toContain("?.click()");
    // The listeners go when the node does, and the caller's own ref survives.
    expect(content).toContain("return () => {");
    expect(content).toContain("detach();");
  });

  it("stops the scroller from chaining a pull into the page", () => {
    expect(content).toContain("overscroll-y-contain");
  });

  it("writes one transform on one element: no React state, no animation library", () => {
    expect(dragSource).not.toMatch(/useState|useReducer|from "react"/);
    expect(dragSource).toContain("el.style.transform");
    const pkg = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
    };
    for (const name of ["framer-motion", "motion", "vaul", "react-spring"]) {
      expect(pkg.dependencies[name], name).toBeUndefined();
    }
  });

  it("honours prefers-reduced-motion and still closes", () => {
    expect(dragSource).toContain("prefers-reduced-motion: reduce");
    // The reduced-motion branch of slideOut closes at once.
    expect(dragSource).toMatch(
      /const slideOut = \(\) => \{\s*if \(prefersReducedMotion\(\)\) \{\s*close\(\);/,
    );
  });

  it("is a phone behaviour: nothing from the sm breakpoint up", () => {
    expect(dragSource).toContain('"(min-width: 640px)"');
    expect(content).toContain("sm:inset-auto");
  });

  it("does not hijack sideways scrollers, fields or charts", () => {
    expect(dragSource).toContain("isSwipeExcluded(target, el)");
    expect(dragSource).toContain("canScrollUp(scrollChain(target, el))");
    expect(dragSource).toContain("SHEET_NO_DRAG_SELECTOR");
  });

  it("a sheet that slid off does not replay Radix's exit animation", () => {
    expect(css).toMatch(
      /\[data-slot="dialog-content"\]\[data-sheet-closing\] \{\s*animation: none !important;/,
    );
    expect(dragSource).toContain('"data-sheet-closing"');
  });
});

describe("corners that follow the screen", () => {
  it("--radius-screen is defined once, in globals.css only", () => {
    expect(css.match(/--radius-screen:/g)).toHaveLength(1);
    expect(tokens).not.toContain("--radius-screen");
  });

  it("is local, and says so: Mzizi has no sheet or screen radius", () => {
    const at = css.indexOf("--radius-screen:");
    const note = css.slice(css.lastIndexOf("/*", at), at);
    expect(note).toContain("LOCAL");
    expect(note).toContain("mzizi-dev/mzizi-registry");
  });

  it("stands in for a phone screen's corner and keeps Close inside the curve", () => {
    const radius = px(token("--radius-screen"));
    // About 2.5 to 3rem: the range of current phone screens (28 to 55px) that
    // this stand-in has to sit inside.
    expect(radius).toBeGreaterThanOrEqual(40);
    expect(radius).toBeLessThanOrEqual(48);
    // Close is 49px, 7px from the corner: its far edge from the arc's centre
    // is sqrt(2) * (R - 7 - 24.5) + 24.5, which must not pass R.
    const half = px(token("--target-floor")) / 2;
    const gap = px(token("--gap-floor"));
    const reach = Math.SQRT2 * (radius - gap - half) + half;
    expect(reach).toBeLessThanOrEqual(radius);
  });

  it("the phone sheet uses it for its top corners; from sm the card radius", () => {
    const content = fn("DialogContent");
    expect(content).toContain("rounded-t-[var(--radius-screen)]");
    expect(content).toContain("sm:rounded-[var(--radius-card)]");
  });

  it("a sheet stops short of the status bar so the curve shows", () => {
    const content = fn("DialogContent");
    expect(content).toContain("max-h-[calc(100dvh-var(--float-top))]");
    const myWeather = read("src/components/weather/MyWeatherModal.tsx");
    expect(myWeather).toContain("h-[calc(100dvh-var(--float-top))]");
    expect(myWeather).not.toContain("h-[100dvh]");
  });

  it("leaves the home-indicator inset under the content", () => {
    const content = fn("DialogContent");
    expect(content).toContain("h-[env(safe-area-inset-bottom,0px)]");
    expect(content).toContain("sm:hidden");
  });
});

describe("the modals themselves", () => {
  it("My Weather keeps Apply beside Close, and Close still only cancels", () => {
    const src = read("src/components/weather/MyWeatherModal.tsx");
    expect(src).toContain('heading="My Weather"');
    expect(src).toContain("actions={");
    expect(src).toContain("if (!open) handleCancel();");
  });

  it("the detail sheets keep their full-width Close at the foot for the thumb", () => {
    for (const file of [
      "src/components/ui/detail-sheet.tsx",
      "src/components/weather/AirQualityDetail.tsx",
    ]) {
      const src = read(file);
      expect(src, file).toContain("<DialogClose asChild>");
      expect(src, file).toContain("Close");
    }
  });

  it("the install prompt is a sheet on a phone, not a left-hugging card", () => {
    const src = read("src/components/weather/PWAInstallPrompt.tsx");
    expect(src).toContain('<DialogContent className="sm:max-w-sm">');
    expect(src).not.toContain("rounded-[var(--radius-card)] p-6");
  });
});
