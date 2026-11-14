import { describe, expect, it } from "vitest";
import { SEASONS } from "./seed-seasons";
import { localSeason } from "./season-local";
import { getDefaultSeason } from "./weather";

/** A date in the middle of a 1-based month (the server's own clock month). */
const inMonth = (month: number) => new Date(2026, month - 1, 15, 12);

describe("localSeason: the season for a country with no database read", () => {
  it("serves Zimbabwe the name used where the place is, in every month", () => {
    // Harare (ZW19) is Shona-speaking, Bulawayo (ZW10) Ndebele-speaking.
    const harare = { region: "ZW19" };
    const bulawayo = { region: "ZW10" };
    const at = (month: number, names = {}) =>
      localSeason(inMonth(month), "ZW", -17.8, names);
    expect(at(1, harare)).toMatchObject({
      name: "Summer rains",
      localName: "Zhizha",
    });
    expect(at(1, bulawayo)).toMatchObject({
      name: "Summer rains",
      localName: "Ihlobo",
    });
    expect(at(4, harare).localName).toBe("Matsutso");
    expect(at(4, bulawayo).localName).toBe("Ikwindla");
    expect(at(7, harare).localName).toBe("Chando");
    expect(at(7, bulawayo).localName).toBe("Ubusika");
    expect(at(10, harare).localName).toBe("Chirimo");
    expect(at(10, bulawayo).localName).toBe("Intwasahlobo");
    for (let month = 1; month <= 12; month++) {
      for (const names of [harare, bulawayo, {}]) {
        const season = at(month, names);
        expect(season.name).toBeTruthy();
        expect(season.localName).toBeTruthy();
        expect(season.description).toBeTruthy();
      }
    }
  });

  it("does not lock Zimbabwe to Shona: with no region or language it is English", () => {
    expect(localSeason(inMonth(1), "ZW", -17.8)).toMatchObject({
      name: "Summer rains",
      localName: "Summer rains",
    });
  });

  it("answers exactly what the seed table says, for every country and month", () => {
    // The database is filled from this table (POST /api/db-init), and the
    // first season whose months include the month wins, as in getSeasonFromDb.
    const countries = new Set(SEASONS.map((s) => s.countryCode));
    for (const code of countries) {
      for (let month = 1; month <= 12; month++) {
        const expected = SEASONS.find(
          (s) => s.countryCode === code && s.months.includes(month),
        );
        const got = localSeason(inMonth(month), code, 0);
        if (expected) {
          expect(got, `${code} ${month}`).toEqual({
            name: expected.name,
            localName: expected.localName || expected.name,
            description: expected.description,
          });
        } else {
          expect(got, `${code} ${month}`).toEqual(
            getDefaultSeason(inMonth(month), 0),
          );
        }
      }
    }
  });

  it("falls back to the hemisphere default for a country the table does not hold", () => {
    expect(localSeason(inMonth(1), "GB", 51.5)).toEqual(
      getDefaultSeason(inMonth(1), 51.5),
    );
    expect(localSeason(inMonth(1), "AU", -33.9)).toEqual(
      getDefaultSeason(inMonth(1), -33.9),
    );
  });

  it("falls back to the hemisphere default with no country at all", () => {
    expect(localSeason(inMonth(7), "", -17.8)).toEqual(
      getDefaultSeason(inMonth(7), -17.8),
    );
    expect(localSeason(inMonth(7), "", 17.8)).toEqual(
      getDefaultSeason(inMonth(7), 17.8),
    );
  });

  it("accepts a country code in any case, with stray spaces", () => {
    expect(localSeason(inMonth(1), " zw ", -17.8)).toEqual(
      localSeason(inMonth(1), "ZW", -17.8),
    );
  });

  it("never reads a database", async () => {
    const source = (await import("fs"))
      .readFileSync(new URL("./season-local.ts", import.meta.url), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source).not.toMatch(/@\/lib\/db|\.\/db"|mongo|getSeasonForDate/i);
  });
});
