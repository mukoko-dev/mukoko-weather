import { describe, it, expect } from "vitest";
import {
  formatHighLow,
  heroBadgeLabel,
  heroEyebrowBadges,
  isHomeLocation,
} from "./hero";

describe("heroEyebrowBadges", () => {
  it("shows nothing when the place is neither current nor home", () => {
    expect(heroEyebrowBadges(false, false)).toEqual([]);
  });

  it("shows only MY LOCATION for the GPS-confirmed current place", () => {
    expect(heroEyebrowBadges(true, false)).toEqual(["current"]);
  });

  it("shows only HOME when the place is the saved home but not GPS-confirmed", () => {
    expect(heroEyebrowBadges(false, true)).toEqual(["home"]);
  });

  it("shows both badges, current first, when the place is both", () => {
    expect(heroEyebrowBadges(true, true)).toEqual(["current", "home"]);
  });
});

describe("heroBadgeLabel", () => {
  it("labels the current-location badge My Location", () => {
    expect(heroBadgeLabel("current")).toBe("My Location");
  });

  it("labels the home badge Home", () => {
    expect(heroBadgeLabel("home")).toBe("Home");
  });
});

describe("isHomeLocation", () => {
  it("matches when the slug equals the home slug", () => {
    expect(isHomeLocation("singapore-sg", "singapore-sg")).toBe(true);
  });

  it("does not match a different slug", () => {
    expect(isHomeLocation("harare", "singapore-sg")).toBe(false);
  });

  it("is false when no home is set", () => {
    expect(isHomeLocation("harare", null)).toBe(false);
    expect(isHomeLocation("harare", undefined)).toBe(false);
  });

  it("is false when the page has no slug", () => {
    expect(isHomeLocation(undefined, "harare")).toBe(false);
    expect(isHomeLocation(undefined, null)).toBe(false);
  });
});

describe("formatHighLow", () => {
  it("formats the hero line with two spaces between H and L", () => {
    expect(formatHighLow(34.4, 24.6)).toBe("H:34°  L:25°");
  });

  it("rounds each value to the nearest whole degree", () => {
    expect(formatHighLow(33.5, 25.49)).toBe("H:34°  L:25°");
  });

  it("returns null when either value is missing", () => {
    expect(formatHighLow(undefined, 25)).toBeNull();
    expect(formatHighLow(34, null)).toBeNull();
  });

  it("returns null for non-finite values so NaN never renders", () => {
    expect(formatHighLow(Number.NaN, 25)).toBeNull();
    expect(formatHighLow(34, Number.POSITIVE_INFINITY)).toBeNull();
  });
});
