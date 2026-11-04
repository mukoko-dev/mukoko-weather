import { describe, expect, it } from "vitest";
import { decodeGeohash, encodeGeohash } from "../geohash";
import { buildSmartSlug } from "../smart-slug";
import {
  ALERT_GEOHASH_LENGTH,
  MAX_ALERT_PLACES,
  PLACE_KEY_RE,
  alertPlaceKey,
  alertPlaceKeys,
  isAlertPlaceKey,
} from "./place-key";

describe("isAlertPlaceKey (the API and validator grammar)", () => {
  it.each([
    "harare",
    "nairobi-ke",
    "mbare-musika--ksy4d",
    "place--ksy4d",
    "decade", // no dash before the six letters, so the hex rule does not apply
  ])("accepts %s", (key) => {
    expect(isAlertPlaceKey(key)).toBe(true);
  });

  it.each([
    ["a seven-character spot", "harare--ksy4dd7"],
    ["a six-character spot", "harare--ksy4dd"],
    ["a four-character spot", "harare--ksy4"],
    ["a map feature ref", "canberra-residences--osm-w890123"],
    ["a coordinate label", "12-35n-45-62e"],
    ["a coordinate label with a cell", "12-35n-45-62e--ksy4d"],
    ["a platform slug ending in six hex digits", "harare-a1b2c3"],
    ["a name ending in six hex digits before a cell", "river-decade--ksy4d"],
    ["a trailing newline", "harare\n"],
    ["an upper-case slug", "Harare"],
    ["a geohash with a letter outside the alphabet", "harare--ksy4a"],
    ["an empty key", ""],
    ["a key over 80 characters", `${"a".repeat(75)}--ksy4d`],
  ])("refuses %s", (_label, key) => {
    expect(isAlertPlaceKey(key)).toBe(false);
  });

  it("is anchored: nothing may follow a valid key", () => {
    expect(PLACE_KEY_RE.test("harare extra")).toBe(false);
    expect(PLACE_KEY_RE.test("harare--ksy4d--ksy4d")).toBe(false);
  });
});

describe("alertPlaceKey", () => {
  it("keeps a catalogue slug as it is", () => {
    expect(alertPlaceKey("harare")).toBe("harare");
    expect(alertPlaceKey("nairobi-ke")).toBe("nairobi-ke");
  });

  it("cuts a seven-character saved spot to its five-character cell", () => {
    expect(alertPlaceKey("harare--ksy4dd7")).toBe("harare--ksy4d");
    expect(alertPlaceKey("mbare-musika--ksy4d6r")).toBe("mbare-musika--ksy4d");
  });

  it("leaves a five-character spot alone and cuts a six-character one", () => {
    expect(alertPlaceKey("harare--ksy4d")).toBe("harare--ksy4d");
    expect(alertPlaceKey("harare--ksy4dd")).toBe("harare--ksy4d");
  });

  it("refuses a spot too coarse to be a forecast place", () => {
    expect(alertPlaceKey("harare--ksy4")).toBeNull();
    expect(alertPlaceKey("harare--ks")).toBeNull();
  });

  it("gives null for a map feature, which has no coordinate in its slug", () => {
    expect(alertPlaceKey("canberra-residences--osm-w890123")).toBeNull();
  });

  it("gives null for slugs the grammar refuses outright", () => {
    expect(alertPlaceKey("12-35n-45-62e")).toBeNull();
    expect(alertPlaceKey("harare-a1b2c3")).toBeNull();
    expect(alertPlaceKey("harare\n")).toBeNull();
    expect(alertPlaceKey("")).toBeNull();
    expect(alertPlaceKey("x".repeat(81))).toBeNull();
  });

  it("falls back to a neutral name when the spot's own name cannot be in a key", () => {
    // A coordinate label is about 1 km; the key may carry the 5 km cell only.
    expect(alertPlaceKey("12-35n-45-62e--ksy4dd7")).toBe("place--ksy4d");
    // A name ending in six hex digits would be read as a platform slug.
    expect(alertPlaceKey("river-decade--ksy4dd7")).toBe("place--ksy4d");
  });

  it("never returns anything the grammar refuses, or anything finer than the cell", () => {
    const names = [
      "harare",
      "525 Canberra Drive",
      "Bulawayo",
      "12.35N 45.62E",
      "café déjà vu",
      "",
      "a",
    ];
    for (let lat = -80; lat <= 80; lat += 17.3) {
      for (let lon = -170; lon <= 170; lon += 23.7) {
        for (const name of names) {
          const slug = buildSmartSlug(name, lat, lon);
          const key = alertPlaceKey(slug);
          expect(key, slug).not.toBeNull();
          expect(isAlertPlaceKey(key as string), slug).toBe(true);
          const cell = (key as string).split("--")[1];
          expect(cell).toHaveLength(ALERT_GEOHASH_LENGTH);
          // The cell is a prefix of the spot's own geohash: same place, coarser.
          expect(slug.endsWith(`--${encodeGeohash(lat, lon, 7)}`)).toBe(true);
          expect(encodeGeohash(lat, lon, 7).startsWith(cell)).toBe(true);
        }
      }
    }
  });

  it("keeps the person inside the cell it names", () => {
    const lat = -17.8288;
    const lon = 31.0522;
    const key = alertPlaceKey(buildSmartSlug("My farm", lat, lon)) as string;
    const decoded = decodeGeohash(key.split("--")[1]);
    expect(decoded).not.toBeNull();
    const b = decoded!.bounds;
    expect(lat).toBeGreaterThanOrEqual(b.latMin);
    expect(lat).toBeLessThanOrEqual(b.latMax);
    expect(lon).toBeGreaterThanOrEqual(b.lonMin);
    expect(lon).toBeLessThanOrEqual(b.lonMax);
    // About 4.9 km square: the cell is far coarser than the 153 m spot.
    expect((b.latMax - b.latMin) * 111).toBeGreaterThan(4);
    expect((b.latMax - b.latMin) * 111).toBeLessThan(6);
  });
});

describe("alertPlaceKeys", () => {
  it("maps in order and drops what cannot be made coarse", () => {
    expect(
      alertPlaceKeys([
        "harare",
        "mbare-musika--ksy4d6r",
        "canberra-residences--osm-w890123",
        "12-35n-45-62e",
        "nairobi-ke",
      ]),
    ).toEqual(["harare", "mbare-musika--ksy4d", "nairobi-ke"]);
  });

  it("counts two spots in one 5 km cell as one place", () => {
    expect(alertPlaceKeys(["home--ksy4dd7", "work--ksy4d6r"])).toEqual([
      "home--ksy4d",
    ]);
  });

  it("asks for at most ten places", () => {
    const slugs = Array.from(
      { length: 25 },
      (_, i) => `town-${String.fromCharCode(97 + (i % 26))}x${i}`,
    );
    const keys = alertPlaceKeys(slugs);
    expect(keys).toHaveLength(MAX_ALERT_PLACES);
    expect(keys.every(isAlertPlaceKey)).toBe(true);
  });

  it("returns nothing for nothing", () => {
    expect(alertPlaceKeys([])).toEqual([]);
  });
});
