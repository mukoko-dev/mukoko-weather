import { describe, expect, it } from "vitest";
import {
  HEADER_DESTINATIONS,
  NOTIFICATIONS_EMPTY_TEXT,
  isDestinationActive,
  visibleHeaderDestinations,
  weatherMapHref,
} from "./header-nav";
import { FLAGS } from "./feature-flags";

describe("header-nav", () => {
  it("lists Explore, Shamwari (flagged), History, Aviation in order", () => {
    expect(HEADER_DESTINATIONS.map((d) => d.label)).toEqual([
      "Explore",
      "Shamwari",
      "History",
      "Aviation",
    ]);
    expect(
      HEADER_DESTINATIONS.filter((d) => d.flag).map((d) => d.flag),
    ).toEqual(["shamwari_chat"]);
  });

  it("hides a flagged destination while its flag is off", () => {
    const off = visibleHeaderDestinations(
      (f) => FLAGS[f] && f !== "shamwari_chat",
    );
    expect(off.map((d) => d.href)).not.toContain("/shamwari");
    const on = visibleHeaderDestinations(() => true);
    expect(on.map((d) => d.href)).toContain("/shamwari");
  });

  it("marks Explore active on its sub-pages, the rest only on their own page", () => {
    expect(isDestinationActive("/explore", "/explore")).toBe(true);
    expect(isDestinationActive("/explore/country/zw", "/explore")).toBe(true);
    expect(isDestinationActive("/exploreX", "/explore")).toBe(false);
    expect(isDestinationActive("/history", "/history")).toBe(true);
    expect(isDestinationActive("/history/x", "/history")).toBe(false);
  });

  it("links the weather map for the place on screen, else Explore", () => {
    expect(weatherMapHref("harare")).toBe("/harare/map");
    expect(weatherMapHref(null)).toBe("/explore");
  });

  it("says there are no notifications yet", () => {
    expect(NOTIFICATIONS_EMPTY_TEXT).toBe("No notifications yet");
  });
});
