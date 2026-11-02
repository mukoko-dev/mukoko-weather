import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  DEFAULT_HOME_SLUG,
  DEFAULT_PAGER_SLUGS,
  defaultHomeLocation,
} from "./default-home";
import { LOCATIONS } from "./locations";
import { suggestPresetSlugs, visiblePresetSlugs } from "./location-presets";
import { pagerSequence } from "./location-pager";

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf-8");

describe("the default load is Harare, never a chooser (#414)", () => {
  it("the default is the shipped Harare seed, so it renders without a lookup", () => {
    const loc = defaultHomeLocation();
    expect(DEFAULT_HOME_SLUG).toBe("harare");
    expect(loc.slug).toBe("harare");
    expect(loc.country).toBe("ZW");
    expect(LOCATIONS.some((l) => l.slug === "harare")).toBe(true);
    expect(Number.isFinite(loc.lat) && Number.isFinite(loc.lon)).toBe(true);
  });

  it("the default pager is Harare, Nairobi and Lagos, all shipped seed slugs", () => {
    expect(DEFAULT_PAGER_SLUGS).toEqual(["harare", "nairobi-ke", "lagos-ng"]);
    for (const slug of DEFAULT_PAGER_SLUGS) {
      expect(
        LOCATIONS.some((l) => l.slug === slug),
        slug,
      ).toBe(true);
    }
  });

  it("a visitor who has saved nothing is suggested exactly those three, in that order", () => {
    expect(suggestPresetSlugs(null)).toEqual([...DEFAULT_PAGER_SLUGS]);
    expect(
      visiblePresetSlugs({
        anchor: null,
        hidden: [],
        saved: [],
        current: null,
      }),
    ).toEqual([...DEFAULT_PAGER_SLUGS]);
    // The bottom nav pager: My Location first, then the three.
    expect(
      pagerSequence(
        [],
        visiblePresetSlugs({
          anchor: null,
          hidden: [],
          saved: [],
          current: null,
        }),
      ),
    ).toEqual(["/", "/harare", "/nairobi-ke", "/lagos-ng"]);
  });
});

describe("the home page falls back to Harare (source)", () => {
  const page = read("../app/page.tsx");
  const home = read("../app/CurrentLocationHome.tsx");

  it("page.tsx seeds Harare when no cookie and no usable IP position resolve", () => {
    expect(page).toContain("defaultHomeLocation()");
    // The server seed is never "nothing" any more.
    expect(page).not.toContain("No server-side location at all");
  });

  it("the city chooser is gone from the home page; search and browse stay reachable", () => {
    for (const text of [
      "Find your weather",
      "Use my current location",
      "Search for a city",
      "Browse all locations",
      'aria-label="Location selection"',
    ]) {
      expect(home).not.toContain(text);
    }
    // Where search and browse live instead (My Weather, the prompt card, the
    // header / phone menu, the Locations list).
    expect(home).toContain("onSearch={() => openMyWeather()}");
    expect(read("../components/layout/PhoneMenu.tsx")).toContain(
      "openMyWeather",
    );
    expect(read("../lib/nav-destinations.ts")).toContain("/explore");
    expect(read("../components/layout/MobileNav.tsx")).toContain("/locations");
  });

  it("with nothing seeded the client shows Harare (or the remembered shipped place) through the place stage", () => {
    // The stage paints a stored copy, fetches through the shared Worker read,
    // retries with a backoff and ends in a notice with "Try again": a
    // guaranteed exit, and never made-up numbers.
    expect(home).toContain(
      "controller.showHome(seedFor(remembered ?? defaultHomeLocation()))",
    );
    expect(home).toContain("LocationSkeleton");
  });

  it("the server render imports Harare from a module that loads no weather", () => {
    expect(page).toContain('from "@/lib/default-home-place"');
    expect(read("default-home-place.ts")).not.toMatch(/home-weather|weather"/);
  });
});
