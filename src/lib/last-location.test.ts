import { describe, it, expect } from "vitest";
import {
  LAST_LOCATION_COOKIE,
  LAST_LOCATION_MAX_AGE_S,
  readLastLocation,
  type CookieJar,
} from "./last-location";

function jar(value: string | undefined): CookieJar {
  return {
    get: (name) =>
      name === "lastLocation" && value !== undefined ? { value } : undefined,
  };
}

describe("last-location", () => {
  it("names the cookie and its 30-day lifetime", () => {
    expect(LAST_LOCATION_COOKIE).toBe("lastLocation");
    expect(LAST_LOCATION_MAX_AGE_S).toBe(30 * 24 * 60 * 60);
  });

  it("reads a valid slug, smart slug included", () => {
    expect(readLastLocation(jar("harare"))).toBe("harare");
    expect(readLastLocation(jar("koh-samui--ksy4dd7"))).toBe(
      "koh-samui--ksy4dd7",
    );
  });

  it("returns null when the cookie is absent or not a slug", () => {
    expect(readLastLocation(jar(undefined))).toBeNull();
    expect(readLastLocation(jar(""))).toBeNull();
    expect(readLastLocation(jar("Harare"))).toBeNull();
    expect(readLastLocation(jar("../etc"))).toBeNull();
  });
});
