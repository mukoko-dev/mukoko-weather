/**
 * Which routes get the whole stylesheet in their first paint, and which get a
 * subset (issue #551).
 *
 * `/` and the place page (`/[location]`) put the rules their first screen uses
 * inline in the head and fetch the rest of the sheet after the first paint
 * (src/components/layout/FirstScreenStyles.tsx, src/lib/critical-css). Every
 * other route is unchanged: the sheet is linked in its head, as the root layout
 * used to do for all of them. Next.js includes a stylesheet in a route through
 * the modules the route imports, so "unchanged" is a property of the imports:
 * these tests read them.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APP = resolve(__dirname);
const read = (path: string) => readFileSync(join(APP, path), "utf-8");

/** The two pages that take the subset instead of the sheet. */
const FIRST_SCREEN_PAGES = ["page.tsx", "[location]/page.tsx"];

const SHEET_IMPORT = /^import\s+["']@\/app\/globals\.css["'];?$/m;

function pages(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) pages(path, found);
    else if (entry === "page.tsx") found.push(relative(APP, path));
  }
  return found;
}

describe("the root layout no longer links the whole stylesheet for every route", () => {
  const layout = read("layout.tsx");

  it("does not import the sheet", () => {
    expect(layout).not.toMatch(/globals\.css/);
  });
});

describe("every route but the two first-screen pages imports the whole stylesheet", () => {
  const all = pages(APP);

  it("finds the pages", () => {
    expect(all.length).toBeGreaterThan(20);
    for (const first of FIRST_SCREEN_PAGES) expect(all).toContain(first);
  });

  it.each(all.filter((p) => !FIRST_SCREEN_PAGES.includes(p)))(
    "%s imports globals.css, before anything that brings its own styles",
    (page) => {
      const source = read(page);
      expect(source).toMatch(SHEET_IMPORT);
      // The sheet is the first import, so it stays ahead of component styles
      // (as it was: the root layout imported it first).
      const firstImport = source.match(/^import\s.*$/m)?.[0] ?? "";
      expect(firstImport).toMatch(SHEET_IMPORT);
    },
  );

  it("the root boundaries do not import it: a boundary's stylesheet is announced to every route under it as a preload of the whole sheet", () => {
    expect(read("error.tsx")).not.toMatch(/globals\.css/);
    expect(read("not-found.tsx")).not.toMatch(/globals\.css/);
    expect(read("layout.tsx")).not.toMatch(/globals\.css/);
  });

  it("the root not-found page asks for the sheet from AppChrome, a component every route already loads", () => {
    const styles = readFileSync(
      resolve(APP, "../components/layout/AppChrome.tsx"),
      "utf-8",
    );
    expect(styles).toContain('document.getElementById("not-found-heading")');
    expect(styles).toMatch(/import\("@\/app\/globals\.css"\)/);
    // not-found.tsx itself is the view, unchanged: no client module of its own
    expect(read("not-found.tsx")).toMatch(/export default LocationNotFound/);
  });

  it("the embed widget imports it before its own stylesheet", () => {
    const widget = read("embed/widget/page.tsx");
    expect(widget.indexOf("globals.css")).toBeGreaterThan(-1);
    expect(widget.indexOf("globals.css")).toBeLessThan(
      widget.indexOf("./widget.css"),
    );
  });
});

describe("the two first-screen pages take the subset", () => {
  it.each(FIRST_SCREEN_PAGES)("%s does not import the whole sheet", (page) => {
    expect(read(page)).not.toMatch(/globals\.css/);
  });

  it.each(FIRST_SCREEN_PAGES)(
    "%s puts the subset in the head (the module that does so asks for the sheet after paint)",
    (page) => {
      const source = read(page);
      expect(source).toContain("<CriticalStyles />");
      expect(source).toContain("@/components/layout/FirstScreenStyles");
    },
  );

  it("the place page's loading view carries the subset too, so it is in the shell the loading view paints", () => {
    const loading = read("[location]/loading.tsx");
    expect(loading).toContain("<CriticalStyles />");
    // The sub-routes keep their own loading views and so do not get it.
    for (const sub of ["agriculture", "atmosphere", "forecast", "map"])
      expect(read(`[location]/${sub}/loading.tsx`)).not.toContain(
        "CriticalStyles",
      );
  });
});

describe("FirstScreenStyles sends the subset once", () => {
  const source = readFileSync(
    resolve(APP, "../components/layout/FirstScreenStyles.tsx"),
    "utf-8",
  );

  it("is a Client Component, so the server tree does not send the text a second time", () => {
    expect(source.trimStart().startsWith('"use client"')).toBe(true);
  });

  it("holds the text only in the server render, so the browser's scripts do not carry it", () => {
    expect(source).toContain(
      'typeof window === "undefined" ? critical.css : ""',
    );
  });

  it("asks for the sheet only once the first screen has painted and the browser is idle", () => {
    expect(source).toContain("[data-sky-hero]:not([data-skeleton])");
    expect(source).toContain("#not-found-heading");
    expect(source).toContain("afterPaintWhenIdle(start)");
    expect(source).toContain("afterWeather(requestFullStylesheet)");
    // and never later than a bound, for a page that gets no weather
    expect(source).toMatch(/WEATHER_MAX_WAIT_MS = \d+/);
  });

  it("loads the sheet with a dynamic import, which nothing waits for", () => {
    expect(source).toMatch(/import\("@\/app\/globals\.css"\)/);
    // not a static import: that would link the sheet in the head again
    expect(source).not.toMatch(/^import\s+["']@\/app\/globals\.css["']/m);
  });
});
