import { describe, it, expect } from "vitest";
import {
  NAV_DESTINATIONS,
  NAV_GROUPS,
  PROFILE_DESTINATIONS,
  navDestination,
  type NavDestinationId,
} from "./nav-destinations";

describe("NAV_DESTINATIONS", () => {
  it("has a unique id and href for every destination", () => {
    const ids = NAV_DESTINATIONS.map((d) => d.id);
    const hrefs = NAV_DESTINATIONS.map((d) => d.href);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("puts every destination in a known group", () => {
    const groups = new Set(NAV_GROUPS.map((g) => g.id));
    for (const d of NAV_DESTINATIONS) expect(groups.has(d.group)).toBe(true);
  });

  it("gives every destination a non-empty label and description", () => {
    for (const d of NAV_DESTINATIONS) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.description.length).toBeGreaterThan(0);
    }
  });

  it("keeps the profile page's routes, in its order", () => {
    expect(PROFILE_DESTINATIONS.map((d) => d.href)).toEqual([
      "/",
      "/locations",
      "/explore",
      "/history",
      "/aviation",
      "/developers/keys",
      "/developers",
      "/help",
      "/releases",
      "/status",
      "/about",
      "/terms",
      "/privacy",
    ]);
  });

  it("does not list the paused Shamwari page on the profile", () => {
    expect(PROFILE_DESTINATIONS.some((d) => d.href === "/shamwari")).toBe(
      false,
    );
  });

  it("keeps footer labels where the footer reads them differently", () => {
    expect(navDestination("history").footerLabel).toBe("Historical data");
    expect(navDestination("privacy").footerLabel).toBe("Privacy");
    expect(navDestination("explore").footerLabel).toBeUndefined();
  });
});

describe("navDestination", () => {
  it("returns the destination for an id", () => {
    expect(navDestination("aviation").href).toBe("/aviation");
  });

  it("throws on an unknown id rather than rendering a dead link", () => {
    expect(() => navDestination("nope" as NavDestinationId)).toThrow(
      /Unknown nav destination/,
    );
  });
});
