import { describe, it, expect } from "vitest";
import {
  MAX_PAGER_DOTS,
  MY_LOCATION_HREF,
  neighbour,
  pagerDots,
  pagerIndex,
  pagerSequence,
} from "./location-pager";

describe("pagerSequence", () => {
  it("starts with the My Location page and then one page per saved slug", () => {
    expect(pagerSequence(["harare", "nairobi-ke"])).toEqual([
      "/",
      "/harare",
      "/nairobi-ke",
    ]);
  });

  it("returns only the home page when nothing is saved", () => {
    expect(pagerSequence([])).toEqual([MY_LOCATION_HREF]);
    expect(pagerSequence(undefined)).toEqual([MY_LOCATION_HREF]);
    expect(pagerSequence(null)).toEqual([MY_LOCATION_HREF]);
  });

  it("drops duplicate slugs, keeping the first occurrence", () => {
    expect(pagerSequence(["harare", "gweru", "harare"])).toEqual([
      "/",
      "/harare",
      "/gweru",
    ]);
  });

  it("drops anything that is not a location slug (route names, bad syntax, non-strings)", () => {
    expect(
      pagerSequence([
        "explore",
        "Harare",
        "bad slug",
        "",
        42,
        null,
        "../etc",
        "harare",
      ]),
    ).toEqual(["/", "/harare"]);
  });

  it("keeps a smart slug with its -- delimiter", () => {
    expect(pagerSequence(["west-paddock--ksy4dd7"])).toEqual([
      "/",
      "/west-paddock--ksy4dd7",
    ]);
  });
});

describe("pagerIndex", () => {
  const sequence = ["/", "/harare", "/nairobi-ke"];

  it("maps the home page to index 0", () => {
    expect(pagerIndex("/", sequence)).toBe(0);
  });

  it("maps a saved location page to its index", () => {
    expect(pagerIndex("/harare", sequence)).toBe(1);
    expect(pagerIndex("/nairobi-ke", sequence)).toBe(2);
  });

  it("treats sub-routes as their location (/harare/map is the harare page)", () => {
    expect(pagerIndex("/harare/map", sequence)).toBe(1);
    expect(pagerIndex("/harare/forecast/", sequence)).toBe(1);
    expect(pagerIndex("/nairobi-ke/atmosphere", sequence)).toBe(2);
  });

  it("returns -1 for pages that are not in the pager", () => {
    expect(pagerIndex("/explore", sequence)).toBe(-1);
    expect(pagerIndex("/history", sequence)).toBe(-1);
    expect(pagerIndex("/gweru", sequence)).toBe(-1);
  });

  it("treats an empty or missing pathname as the home page", () => {
    expect(pagerIndex("", sequence)).toBe(0);
    expect(pagerIndex(null, sequence)).toBe(0);
    expect(pagerIndex(undefined, sequence)).toBe(0);
  });

  it("returns -1 against an empty sequence", () => {
    expect(pagerIndex("/", [])).toBe(-1);
  });
});

describe("neighbour", () => {
  const sequence = ["/", "/harare", "/nairobi-ke"];

  it("steps forward and backward through the sequence", () => {
    expect(neighbour(sequence, 0, 1)).toBe("/harare");
    expect(neighbour(sequence, 1, 1)).toBe("/nairobi-ke");
    expect(neighbour(sequence, 2, -1)).toBe("/harare");
    expect(neighbour(sequence, 1, -1)).toBe("/");
  });

  it("returns null at either end instead of wrapping", () => {
    expect(neighbour(sequence, 0, -1)).toBeNull();
    expect(neighbour(sequence, 2, 1)).toBeNull();
  });

  it("returns null when the current page is not in the pager", () => {
    expect(neighbour(sequence, -1, 1)).toBeNull();
    expect(neighbour(sequence, -1, -1)).toBeNull();
  });

  it("returns null when the index is past the end of the sequence", () => {
    expect(neighbour(sequence, 3, -1)).toBeNull();
    expect(neighbour(sequence, 9, 1)).toBeNull();
  });

  it("returns null for a single-page sequence in both directions", () => {
    expect(neighbour(["/"], 0, 1)).toBeNull();
    expect(neighbour(["/"], 0, -1)).toBeNull();
  });

  it("returns null for an empty sequence", () => {
    expect(neighbour([], 0, 1)).toBeNull();
  });
});

describe("pagerDots", () => {
  it("excludes the home page (it has its own glyph)", () => {
    expect(pagerDots(["/", "/harare", "/gweru"])).toEqual([
      "/harare",
      "/gweru",
    ]);
  });

  it("is empty when only the home page exists", () => {
    expect(pagerDots(["/"])).toEqual([]);
  });

  it("caps the visible dots at MAX_PAGER_DOTS", () => {
    const slugs = Array.from({ length: 30 }, (_, i) => `place-${i}`);
    const dots = pagerDots(pagerSequence(slugs));
    expect(MAX_PAGER_DOTS).toBe(24);
    expect(dots).toHaveLength(MAX_PAGER_DOTS);
    expect(dots[0]).toBe("/place-0");
  });
});

describe("pagerSequence with suggested places", () => {
  it("lists My Location, then saved places, then visible suggested places", () => {
    expect(pagerSequence(["harare"], ["bulawayo", "nairobi-ke"])).toEqual([
      "/",
      "/harare",
      "/bulawayo",
      "/nairobi-ke",
    ]);
  });

  it("shows suggested places when nothing is saved", () => {
    expect(pagerSequence([], ["harare", "bulawayo"])).toEqual([
      "/",
      "/harare",
      "/bulawayo",
    ]);
  });

  it("keeps the first occurrence when a saved place is also suggested", () => {
    expect(pagerSequence(["harare"], ["harare", "bulawayo"])).toEqual([
      "/",
      "/harare",
      "/bulawayo",
    ]);
  });

  it("drops route names and bad slugs from the suggestions too", () => {
    expect(pagerSequence([], ["explore", "Bad Slug", "bulawayo"])).toEqual([
      "/",
      "/bulawayo",
    ]);
  });

  it("fits every saved place (10) plus every suggestion within the dot cap", () => {
    const saved = Array.from({ length: 10 }, (_, i) => `saved-${i}`);
    const presets = ["harare", "bulawayo", "a-1", "a-2", "a-3", "a-4"];
    const dots = pagerDots(pagerSequence(saved, presets));
    expect(dots).toHaveLength(saved.length + presets.length);
  });
});
