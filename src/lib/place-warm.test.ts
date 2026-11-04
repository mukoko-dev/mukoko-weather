import { describe, expect, it } from "vitest";
import {
  WARM_PLACES,
  WARM_PLACES_CONSTRAINED,
  warmLimit,
  warmTargets,
} from "./place-warm";
import type { DeviceHints } from "./lazy-visibility";
import { pagerSequence } from "./location-pager";

const phone: DeviceHints = { viewportWidth: 393, viewportHeight: 852 };

describe("warmLimit: how many places to get ready", () => {
  it("four on a capable device, two each way", () => {
    expect(warmLimit(phone, true)).toBe(WARM_PLACES);
    expect(WARM_PLACES).toBe(4);
    expect(warmLimit({ ...phone, deviceMemory: 8 }, true)).toBe(WARM_PLACES);
  });

  it("only the next place on a low-memory device", () => {
    expect(warmLimit({ ...phone, deviceMemory: 2 }, true)).toBe(
      WARM_PLACES_CONSTRAINED,
    );
    expect(warmLimit({ ...phone, deviceMemory: 1 }, true)).toBe(1);
  });

  it("none with Save-Data on, however much memory there is", () => {
    expect(warmLimit({ ...phone, saveData: true }, true)).toBe(0);
    expect(warmLimit({ ...phone, saveData: true, deviceMemory: 8 }, true)).toBe(
      0,
    );
  });

  it("none while offline", () => {
    expect(warmLimit(phone, false)).toBe(0);
  });
});

describe("warmTargets: which places, nearest first", () => {
  const seq = ["/", "/a", "/b", "/c", "/d"];
  const slugs = (t: ReturnType<typeof warmTargets>) =>
    t.map((x) => (x.kind === "home" ? "/" : x.slug));

  it("the next page, the previous one, then outwards", () => {
    expect(slugs(warmTargets(seq, "/b", 4))).toEqual(["c", "a", "d", "/"]);
    expect(slugs(warmTargets(seq, "/b", 2))).toEqual(["c", "a"]);
    expect(slugs(warmTargets(seq, "/b", 1))).toEqual(["c"]);
  });

  it("at either end it walks the one side that exists", () => {
    expect(slugs(warmTargets(seq, "/", 4))).toEqual(["a", "b", "c", "d"]);
    expect(slugs(warmTargets(seq, "/d", 3))).toEqual(["c", "b", "a"]);
  });

  it("never includes the page on screen, and a sub-route counts as its place", () => {
    expect(slugs(warmTargets(seq, "/b/forecast", 10))).not.toContain("b");
    expect(slugs(warmTargets(seq, "/b/forecast", 1))).toEqual(["c"]);
  });

  it("is empty for a page outside the pager, or with no limit", () => {
    expect(warmTargets(seq, "/zzz", 4)).toEqual([]);
    expect(warmTargets(seq, "/explore", 4)).toEqual([]);
    expect(warmTargets(seq, "/b", 0)).toEqual([]);
    expect(warmTargets(seq, "/b", -1)).toEqual([]);
    expect(warmTargets(seq, "/b", Number.NaN)).toEqual([]);
    expect(warmTargets([], "/", 4)).toEqual([]);
  });

  it("counts only places it can warm toward the limit, and never repeats one", () => {
    const odd = ["/", "/a", "/explore", "/a", "/b"];
    // "/explore" is a route, not a place; "/a" appears twice.
    expect(slugs(warmTargets(odd, "/", 3))).toEqual(["a", "b"]);
  });

  it("works on the real pager sequence (My Location first, saved places after)", () => {
    const real = pagerSequence(["harare", "bulawayo"], []);
    expect(slugs(warmTargets(real, "/harare", 4))).toEqual(["bulawayo", "/"]);
  });
});
