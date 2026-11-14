import { describe, expect, it } from "vitest";
import { resolveSeasonName, seasonLabel } from "./season-names";
import type { SeasonName } from "./seed-seasons";

const names: SeasonName[] = [
  { lang: "en", name: "Summer rains" },
  { lang: "sn", name: "Zhizha", regions: ["ZW11", "ZW19"] },
  { lang: "nd", name: "Ihlobo", regions: ["ZW10", "ZW15"] },
];
const row = { name: "Summer rains", localName: "Summer rains", names };

describe("resolveSeasonName: location, then language, then English", () => {
  it("uses the name for the user's region first", () => {
    expect(resolveSeasonName(row, { region: "ZW19" })).toBe("Zhizha");
    expect(resolveSeasonName(row, { region: "ZW10" })).toBe("Ihlobo");
  });

  it("puts the region before the language, both ways", () => {
    // A Shona speaker standing in Bulawayo is served where they are.
    expect(resolveSeasonName(row, { region: "ZW10", lang: "sn" })).toBe(
      "Ihlobo",
    );
    // An English speaker in Harare is served Harare's name, not English.
    expect(resolveSeasonName(row, { region: "ZW19", lang: "en" })).toBe(
      "Zhizha",
    );
  });

  it("falls back to the user's language when no region is known", () => {
    expect(resolveSeasonName(row, { lang: "sn" })).toBe("Zhizha");
    expect(resolveSeasonName(row, { lang: "nd-ZW" })).toBe("Ihlobo");
    expect(resolveSeasonName(row, { region: null, lang: "SN" })).toBe("Zhizha");
  });

  it("does not hand a name kept for other regions to a place elsewhere, by language alone", () => {
    // ZW12 is a Shona region that this row does not list: the Shona name is
    // kept for ZW11 and ZW19, so a Shona speaker there still gets English.
    expect(resolveSeasonName(row, { region: "ZW12", lang: "sn" })).toBe(
      "Summer rains",
    );
  });

  it("is English when neither the place nor the language says otherwise", () => {
    expect(resolveSeasonName(row)).toBe("Summer rains");
    expect(resolveSeasonName(row, { region: "ZW99", lang: "fr" })).toBe(
      "Summer rains",
    );
    expect(resolveSeasonName(row, { lang: "en" })).toBe("Summer rains");
  });

  it("matches a region without regard to case", () => {
    expect(resolveSeasonName(row, { region: "zw19" })).toBe("Zhizha");
  });

  it("reads a row with no names the old way, so unconverted countries keep working", () => {
    expect(resolveSeasonName({ name: "Long rains", localName: "Masika" })).toBe(
      "Masika",
    );
    expect(resolveSeasonName({ name: "Long rains", localName: "" })).toBe(
      "Long rains",
    );
    expect(
      resolveSeasonName({ name: "Long rains", localName: "Masika", names: [] }),
    ).toBe("Masika");
  });

  it("an English entry that is not the row's own name still wins over the legacy field", () => {
    const r = {
      name: "Dry",
      localName: "Harmattan",
      names: [{ lang: "en", name: "Dry season" }],
    };
    expect(resolveSeasonName(r)).toBe("Dry season");
  });
});

describe("seasonLabel", () => {
  it("writes a distinct local name with the English one beside it", () => {
    expect(seasonLabel({ name: "Summer rains", localName: "Zhizha" })).toBe(
      "Zhizha (Summer rains)",
    );
  });

  it("writes just the English name when there is no other", () => {
    expect(
      seasonLabel({ name: "Summer rains", localName: "Summer rains" }),
    ).toBe("Summer rains");
    expect(seasonLabel({ name: "Summer rains", localName: "" })).toBe(
      "Summer rains",
    );
    expect(seasonLabel({ name: "Summer rains" })).toBe("Summer rains");
  });
});
