import { describe, it, expect } from "vitest";
import {
  MAX_PAGER_DOTS,
  MY_LOCATION_HREF,
  homeChipShowsLabel,
  laneActiveIndex,
  laneChips,
  laneScrollLeft,
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

describe("laneChips — the places lane", () => {
  it("always starts with My Location, then one chip per place in sequence order", () => {
    expect(laneChips(pagerSequence(["harare", "nairobi-ke"]))).toEqual([
      { href: "/", kind: "home", slug: null },
      { href: "/harare", kind: "place", slug: "harare" },
      { href: "/nairobi-ke", kind: "place", slug: "nairobi-ke" },
    ]);
  });

  it("is never empty: with no places the lane is My Location alone", () => {
    expect(laneChips(pagerSequence([]))).toEqual([
      { href: "/", kind: "home", slug: null },
    ]);
    expect(laneChips([])).toHaveLength(1);
    expect(laneChips([])[0].kind).toBe("home");
  });

  it("puts My Location first even when the sequence is malformed", () => {
    // A tampered sequence cannot push a place ahead of the current location.
    expect(laneChips(["/harare", "/gweru"])[0]).toEqual({
      href: "/",
      kind: "home",
      slug: null,
    });
  });

  it("keeps the saved places before the suggested ones (the swipe order)", () => {
    const chips = laneChips(pagerSequence(["harare"], ["bulawayo", "gweru"]));
    expect(chips.map((c) => c.href)).toEqual([
      "/",
      "/harare",
      "/bulawayo",
      "/gweru",
    ]);
  });

  it("is capped at My Location plus MAX_PAGER_DOTS places", () => {
    const slugs = Array.from({ length: 30 }, (_, i) => `place-${i}`);
    expect(laneChips(pagerSequence(slugs))).toHaveLength(MAX_PAGER_DOTS + 1);
  });

  it("lines up one to one with the sequence, so a chip index is a pager index", () => {
    const seq = pagerSequence(["harare", "nairobi-ke", "lagos-ng"]);
    laneChips(seq).forEach((chip, i) => expect(chip.href).toBe(seq[i]));
  });
});

describe("laneActiveIndex — which chip is the current page", () => {
  const seq = pagerSequence(["harare", "nairobi-ke"]);

  it("is 0 (My Location) on the home page", () => {
    expect(laneActiveIndex("/", seq, 3)).toBe(0);
  });

  it("is the place's chip on its page and on its sub-routes", () => {
    expect(laneActiveIndex("/nairobi-ke", seq, 3)).toBe(2);
    expect(laneActiveIndex("/harare/map", seq, 3)).toBe(1);
  });

  it("is -1 on routes that are not places, so exactly one item (or none) is current", () => {
    expect(laneActiveIndex("/explore", seq, 3)).toBe(-1);
    expect(laneActiveIndex("/locations", seq, 3)).toBe(-1);
    expect(laneActiveIndex("/history", seq, 3)).toBe(-1);
    expect(laneActiveIndex("/gweru", seq, 3)).toBe(-1);
  });

  it("is -1 for a place beyond the chips the lane renders", () => {
    expect(laneActiveIndex("/nairobi-ke", seq, 2)).toBe(-1);
  });
});

describe("homeChipShowsLabel — My Location spells its name only when alone", () => {
  it("shows the label when the lane is the single chip", () => {
    expect(homeChipShowsLabel(1)).toBe(true);
    expect(homeChipShowsLabel(0)).toBe(true);
  });

  it("is the glyph alone once there are places beside it", () => {
    expect(homeChipShowsLabel(2)).toBe(false);
    expect(homeChipShowsLabel(11)).toBe(false);
  });
});

describe("laneScrollLeft — centre the active chip in the places scroller", () => {
  // A 190px lane over 600px of chips (My Location is pinned outside it).
  const lane = { viewport: 190, content: 600 };

  it("never scrolls for My Location or when nothing is current: back to the start", () => {
    expect(laneScrollLeft({ ...lane, itemLeft: 4, itemWidth: 90 }, 0)).toBe(0);
    expect(laneScrollLeft({ ...lane, itemLeft: 200, itemWidth: 90 }, -1)).toBe(
      0,
    );
  });

  it("centres the active chip in the scroller", () => {
    // chip centre 300 + 45 = 345; target scroll = 345 - 95 = 250, so its
    // centre sits at 95 px, the middle of the 190px lane.
    const left = laneScrollLeft({ ...lane, itemLeft: 300, itemWidth: 90 }, 4);
    expect(left).toBe(250);
    expect(300 + 90 / 2 - left).toBe(lane.viewport / 2);
  });

  it("clamps at the start: a chip near the start leaves the lane unscrolled", () => {
    expect(laneScrollLeft({ ...lane, itemLeft: 4, itemWidth: 90 }, 1)).toBe(0);
  });

  it("clamps at the end: the last chip scrolls the lane exactly to its end", () => {
    const left = laneScrollLeft({ ...lane, itemLeft: 520, itemWidth: 76 }, 9);
    expect(left).toBe(lane.content - lane.viewport);
  });

  it("does not scroll when everything already fits", () => {
    expect(
      laneScrollLeft(
        { viewport: 300, content: 280, itemLeft: 150, itemWidth: 80 },
        2,
      ),
    ).toBe(0);
  });
});
