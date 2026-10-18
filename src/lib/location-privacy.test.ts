import { describe, it, expect } from "vitest";
import {
  coarsenSlug,
  roundCoord,
  sanitizeEventProps,
  sanitizePath,
  sanitizeUrl,
} from "./location-privacy";

describe("roundCoord", () => {
  it("rounds to 3 decimals", () => {
    expect(roundCoord(-17.8312345)).toBe(-17.831);
    expect(roundCoord(31.0498765)).toBe(31.05);
    expect(roundCoord(5)).toBe(5);
  });
});

describe("coarsenSlug", () => {
  it("keeps legacy catalog slugs", () => {
    expect(coarsenSlug("harare")).toBe("harare");
    expect(coarsenSlug("nairobi-ke")).toBe("nairobi-ke");
    expect(coarsenSlug("gweru")).toBe("gweru");
  });
  it("truncates a spot to a 4 character geohash and drops the name", () => {
    expect(coarsenSlug("west-paddock--ksy4dd7")).toBe("spot--ksy4");
  });
  it("drops an OSM place name and ref", () => {
    expect(coarsenSlug("canberra-residences--osm-w890123")).toBe("place");
  });
});

describe("sanitizePath / sanitizeUrl", () => {
  it("coarsens the slug segment and keeps sub-routes", () => {
    expect(sanitizePath("/west-paddock--ksy4dd7/forecast")).toBe(
      "/spot--ksy4/forecast",
    );
    expect(sanitizePath("/harare/map")).toBe("/harare/map");
    expect(sanitizePath("/")).toBe("/");
  });
  it("drops query and hash from absolute URLs", () => {
    expect(
      sanitizeUrl(
        "https://weather.mukoko.com/west-paddock--ksy4dd7?lat=-17.83123&lon=31.1#x",
      ),
    ).toBe("https://weather.mukoko.com/spot--ksy4");
  });
  it("keeps campaign attribution, drops everything else", () => {
    expect(
      sanitizeUrl(
        "https://weather.mukoko.com/harare?utm_source=wa&UTM_Medium=x&gclid=1&fbclid=2&lat=-17.8&q=home",
      ),
    ).toBe(
      "https://weather.mukoko.com/harare?utm_source=wa&UTM_Medium=x&gclid=1&fbclid=2",
    );
  });
  it("handles empty and invalid input", () => {
    expect(sanitizeUrl("")).toBe("");
    expect(sanitizeUrl(undefined)).toBe("");
  });
});

describe("sanitizeEventProps", () => {
  it("coarsens slug-valued keys only", () => {
    expect(
      sanitizeEventProps({
        from: "harare",
        to: "west-paddock--ksy4dd7",
        method: "geolocation",
        location: "x-y--osm-n1",
        count: 3,
      }),
    ).toEqual({
      from: "harare",
      to: "spot--ksy4",
      method: "geolocation",
      location: "place",
      count: 3,
    });
  });
});
