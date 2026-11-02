import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  DEFAULT_HOME_SLUG,
  DEFAULT_PAGER_SLUGS,
  defaultHomeLocation,
  loadDefaultHomePayload,
} from "./default-home";
import { LOCATIONS } from "./locations";
import { suggestPresetSlugs, visiblePresetSlugs } from "./location-presets";
import { pagerSequence } from "./location-pager";
import { workerData } from "./worker-data";
import { createFallbackWeather } from "./weather";

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

  it("with nothing seeded the client loads Harare instead of showing a chooser", () => {
    expect(home).toContain("loadDefaultHomePayload(slug)");
    expect(home).toContain("LocationSkeleton");
  });
});

describe("loadDefaultHomePayload", () => {
  beforeEach(() => workerData.reset());
  afterEach(() => vi.unstubAllGlobals());

  it("is Harare's live forecast from the Worker", async () => {
    const body = createFallbackWeather(-17.83, 31.05, 1483);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          headers: { "X-Weather-Provider": "open-meteo:blend" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const payload = await loadDefaultHomePayload();
    expect(payload.location.slug).toBe("harare");
    expect(payload.usingFallback).toBe(false);
    expect(payload.countryName).toBe("Zimbabwe");
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain(
      "/v1/weather?",
    );
  });

  it("never throws and never leaves the visitor on a chooser: the seasonal estimate, flagged, when nothing answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const payload = await loadDefaultHomePayload();
    expect(payload.location.slug).toBe("harare");
    expect(payload.usingFallback).toBe(true);
    expect(payload.weather.current).toBeDefined();
    expect(payload.frostAlert).toBeNull();
  });

  it("loads the place this device last showed when it is a shipped place, else Harare", async () => {
    const fetchMock = vi.fn(
      async (url: string | URL) =>
        new Response(
          JSON.stringify(
            createFallbackWeather(
              Number(new URL(String(url)).searchParams.get("lat")),
              Number(new URL(String(url)).searchParams.get("lon")),
              10,
            ),
          ),
          { headers: { "X-Weather-Provider": "open-meteo:blend" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const singapore = await loadDefaultHomePayload("singapore-sg");
    expect(singapore.location.slug).toBe("singapore-sg");
    workerData.reset();
    const unknown = await loadDefaultHomePayload("not-a-shipped-place");
    expect(unknown.location.slug).toBe("harare");
    workerData.reset();
    expect((await loadDefaultHomePayload(null)).location.slug).toBe("harare");
  });
});
