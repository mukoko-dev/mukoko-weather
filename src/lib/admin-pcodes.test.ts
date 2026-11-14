import { describe, expect, it } from "vitest";
import {
  adminPcodeFor,
  knownAdminPcodes,
  placeAdminPcode,
} from "./admin-pcodes";

describe("adminPcodeFor", () => {
  it("gives Zimbabwe's ten provinces their COD-AB P-codes", () => {
    // Read from agriculture.adminAreas (HDX cod-ab-zwe), 2026-11-14.
    const expected: Record<string, string> = {
      Bulawayo: "ZW10",
      Manicaland: "ZW11",
      "Mashonaland Central": "ZW12",
      "Mashonaland East": "ZW13",
      "Mashonaland West": "ZW14",
      "Matabeleland North": "ZW15",
      "Matabeleland South": "ZW16",
      Midlands: "ZW17",
      Masvingo: "ZW18",
      Harare: "ZW19",
    };
    for (const [province, code] of Object.entries(expected)) {
      expect(adminPcodeFor("ZW", province), province).toBe(code);
    }
    expect(new Set(knownAdminPcodes("ZW"))).toEqual(
      new Set(Object.values(expected)),
    );
  });

  it("reads a province however it is written", () => {
    expect(adminPcodeFor("zw", "  matabeleland-north ")).toBe("ZW15");
    expect(adminPcodeFor("ZW", "Harare Province")).toBe("ZW19");
    expect(adminPcodeFor("ZW", "Mashonaland   West")).toBe("ZW14");
  });

  it("never guesses: another country, an unknown province or no province is null", () => {
    expect(adminPcodeFor("KE", "Nairobi")).toBeNull();
    expect(adminPcodeFor("ZW", "Atlantis")).toBeNull();
    expect(adminPcodeFor("ZW", "")).toBeNull();
    expect(adminPcodeFor("ZW", null)).toBeNull();
    expect(adminPcodeFor("", "Harare")).toBeNull();
    expect(adminPcodeFor(undefined, "Harare")).toBeNull();
  });
});

describe("placeAdminPcode", () => {
  it("uses the place's own province", () => {
    expect(placeAdminPcode({ country: "ZW", province: "Bulawayo" })).toBe(
      "ZW10",
    );
  });

  it("ignores a province borrowed from a neighbouring seed", () => {
    expect(
      placeAdminPcode({
        country: "ZW",
        province: "Bulawayo",
        regionApproximate: true,
      }),
    ).toBeNull();
  });
});
