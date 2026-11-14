import { describe, expect, it } from "vitest";
import { knownAdminPcodes } from "./admin-pcodes";
import { resolveSeasonName } from "./season-names";
import { SEASONS } from "./seed-seasons";

const rows = (code: string) => SEASONS.filter((s) => s.countryCode === code);
const FRENCH = /saison|grande|petite|hivernage|chaude/i;

describe("season names in the seed", () => {
  it("every names entry has a language tag and a name, and a region is a P-code", () => {
    for (const s of SEASONS) {
      for (const n of s.names ?? []) {
        expect(n.lang, `${s.countryCode} ${s.name}`).toMatch(/^[a-z]{2,3}$/);
        expect(n.name.trim(), `${s.countryCode} ${s.name}`).not.toBe("");
        for (const r of n.regions ?? []) {
          expect(r, `${s.countryCode} ${s.name}`).toMatch(
            new RegExp(`^${s.countryCode}\\d{2}$`),
          );
        }
      }
    }
  });

  it("a converted row has one English entry that is the English name, and its deprecated localName is that name", () => {
    for (const s of SEASONS.filter((r) => r.names?.length)) {
      const english = (s.names ?? []).filter((n) => n.lang === "en");
      expect(english, `${s.countryCode} ${s.name}`).toEqual([
        { lang: "en", name: s.name },
      ]);
      // The Rust Workers still read this field, so it must not carry a language.
      expect(s.localName, `${s.countryCode} ${s.name}`).toBe(s.name);
    }
  });

  it("Zimbabwe: the four seasons, the months unchanged, the owner's names", () => {
    const zw = rows("ZW");
    expect(
      zw.map((s) => [
        s.name,
        s.months,
        s.names?.find((n) => n.lang === "sn")?.name,
        s.names?.find((n) => n.lang === "nd")?.name,
      ]),
    ).toEqual([
      ["Summer rains", [11, 12, 1, 2, 3], "Zhizha", "Ihlobo"],
      ["Late rains and harvest", [4], "Matsutso", "Ikwindla"],
      ["Cool dry", [5, 6, 7, 8], "Chando", "Ubusika"],
      ["Hot dry", [9, 10], "Chirimo", "Intwasahlobo"],
    ]);
  });

  it("Zimbabwe: Shona and Ndebele cover each province exactly once, from COD-AB", () => {
    const all = knownAdminPcodes("ZW").sort();
    expect(all).toHaveLength(10);
    for (const s of rows("ZW")) {
      const sn = s.names?.find((n) => n.lang === "sn")?.regions ?? [];
      const nd = s.names?.find((n) => n.lang === "nd")?.regions ?? [];
      expect([...sn, ...nd].sort(), s.name).toEqual(all);
      expect(
        sn.filter((r) => nd.includes(r)),
        s.name,
      ).toEqual([]);
      // Matabeleland North and South and Bulawayo speak Ndebele.
      expect([...nd].sort(), s.name).toEqual(["ZW10", "ZW15", "ZW16"]);
    }
  });

  it("Zimbabwe no longer carries the Swahili/Kenyan names", () => {
    const text = JSON.stringify(rows("ZW"));
    for (const wrong of ["Masika", "Munakamwe"]) {
      expect(text).not.toContain(wrong);
    }
    // Zhizha is the summer rains, Chirimo the hot dry spring: not swapped.
    const resolve = (month: number, region: string) =>
      resolveSeasonName(rows("ZW").find((s) => s.months.includes(month))!, {
        region,
      });
    expect(resolve(12, "ZW19")).toBe("Zhizha");
    expect(resolve(9, "ZW19")).toBe("Chirimo");
    expect(resolve(6, "ZW19")).toBe("Chando");
  });

  it("serves a place the name used where it is, per month", () => {
    const at = (month: number, region: string) =>
      resolveSeasonName(rows("ZW").find((s) => s.months.includes(month))!, {
        region,
      });
    expect(at(1, "ZW10")).toBe("Ihlobo"); // Bulawayo
    expect(at(1, "ZW15")).toBe("Ihlobo"); // Matabeleland North
    expect(at(1, "ZW13")).toBe("Zhizha"); // Mashonaland East
    expect(at(4, "ZW16")).toBe("Ikwindla"); // Matabeleland South
    expect(at(7, "ZW18")).toBe("Chando"); // Masvingo
  });

  it("anglophone and lusophone West Africa: English names, no French", () => {
    // Ghana and Nigeria, and Liberia, Sierra Leone and The Gambia (anglophone),
    // and Guinea-Bissau (Portuguese) carried the francophone coast's names.
    for (const code of ["GH", "NG", "LR", "SL", "GM", "GW"]) {
      expect(rows(code), code).toHaveLength(4);
      for (const s of rows(code)) {
        expect(s.names, `${code} ${s.name}`).toEqual([
          { lang: "en", name: s.name },
        ]);
        expect(JSON.stringify(s), `${code} ${s.name}`).not.toMatch(FRENCH);
      }
    }
  });

  it("francophone West Africa keeps its French names", () => {
    for (const code of ["SN", "CI", "BJ", "TG", "GN"]) {
      expect(
        rows(code).some((s) => FRENCH.test(s.localName)),
        code,
      ).toBe(true);
    }
  });

  it("South Africa: English and Afrikaans, as entries among several", () => {
    for (const s of rows("ZA")) {
      expect(s.names?.map((n) => n.lang).sort(), s.name).toEqual(["af", "en"]);
    }
    expect(resolveSeasonName(rows("ZA")[0], { lang: "af" })).toBe("Somer");
    expect(resolveSeasonName(rows("ZA")[0])).toBe("Summer");
  });

  it("Malawi, Zambia, Mozambique and Botswana: English only until a speaker sources more", () => {
    for (const code of ["MW", "ZM", "MZ", "BW"]) {
      expect(rows(code).length, code).toBeGreaterThan(0);
      for (const s of rows(code)) {
        expect(s.names, `${code} ${s.name}`).toEqual([
          { lang: "en", name: s.name },
        ]);
      }
    }
  });

  it("Kenya and Tanzania keep their correct names, untouched", () => {
    for (const code of ["KE", "TZ"]) {
      const local = rows(code).map((s) => s.localName);
      expect(local, code).toContain("Masika");
      expect(local, code).toContain("Vuli");
    }
  });
});
