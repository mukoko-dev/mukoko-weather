import { describe, it, expect } from "vitest";
import { ensoImpact, ensoRegion, type EnsoPhase } from "./enso";

const PHASES: EnsoPhase[] = ["El Niño", "La Niña", "Neutral"];
const GENERIC = "effects vary locally";

describe("ensoRegion", () => {
  it("maps explicit southern African countries to southern-africa", () => {
    for (const cc of [
      "ZW",
      "ZA",
      "ZM",
      "MZ",
      "MW",
      "BW",
      "NA",
      "LS",
      "SZ",
      "AO",
      "MG",
    ]) {
      expect(ensoRegion(cc, -17.8, 31.0)).toBe("southern-africa");
    }
  });

  it("maps East African countries to east-africa", () => {
    for (const cc of ["KE", "TZ", "UG", "ET", "RW", "BI", "SO"]) {
      expect(ensoRegion(cc, 0, 36)).toBe("east-africa");
    }
  });

  it("maps Southeast Asian countries to southeast-asia", () => {
    for (const cc of [
      "SG",
      "MY",
      "ID",
      "TH",
      "PH",
      "VN",
      "BN",
      "KH",
      "LA",
      "MM",
    ]) {
      expect(ensoRegion(cc, 1, 103)).toBe("southeast-asia");
    }
  });

  it("is case-insensitive on the country code", () => {
    expect(ensoRegion("zw", -17.8, 31.0)).toBe("southern-africa");
  });

  it("gives Australia (AU) the generic line, not southern-Africa advice", () => {
    expect(ensoRegion("AU", -33.9, 151.2)).toBe("other");
  });

  it("gives Peru (PE) the generic line", () => {
    expect(ensoRegion("PE", -12, -77)).toBe("other");
  });

  it("gives Papua New Guinea (PG) the generic line", () => {
    expect(ensoRegion("PG", -6.3, 147.2)).toBe("other");
  });

  it("gives a southern African country outside the list the generic line", () => {
    // Known country, not in any list: latitude is never used as a fallback.
    expect(ensoRegion("CL", -33.4, -70.6)).toBe("other");
  });

  it("gives the Democratic Republic of the Congo (CD) the generic line", () => {
    // African but not in the explicit lists; a known code is not overridden.
    expect(ensoRegion("CD", -4.3, 15.3)).toBe("other");
  });

  it("uses the latitude tiebreak when the country is missing and lon is in Africa", () => {
    expect(ensoRegion(undefined, -17.8, 31.0)).toBe("southern-africa");
  });

  it("does not use the tiebreak when the country is missing and lon is outside Africa", () => {
    // Australia's coordinates with no country code.
    expect(ensoRegion(undefined, -33.9, 151.2)).toBe("other");
    // Peru's coordinates with no country code.
    expect(ensoRegion(undefined, -12, -77)).toBe("other");
  });

  it("does not apply the tiebreak at exactly -8 latitude", () => {
    expect(ensoRegion(undefined, -8, 30)).toBe("other");
  });

  it("applies the African longitude bounds inclusively", () => {
    expect(ensoRegion(undefined, -20, -20)).toBe("southern-africa");
    expect(ensoRegion(undefined, -20, 55)).toBe("southern-africa");
    expect(ensoRegion(undefined, -20, 55.01)).toBe("other");
    expect(ensoRegion(undefined, -20, -20.01)).toBe("other");
  });

  it("returns other for northern, unlisted locations", () => {
    expect(ensoRegion("GB", 51.5, -0.1)).toBe("other");
    expect(ensoRegion(undefined, 10, 20)).toBe("other");
  });

  it("returns other for non-finite coordinates without a listed country", () => {
    expect(ensoRegion(undefined, Number.NaN, 30)).toBe("other");
    expect(ensoRegion(undefined, -17.8, Number.NaN)).toBe("other");
  });

  it("lets a listed country win over the latitude rule", () => {
    // Tanzania's south sits below -8, but it is an East Africa country.
    expect(ensoRegion("TZ", -9.5, 34)).toBe("east-africa");
    // Indonesia sits near the equator and below -8 in Java/Timor.
    expect(ensoRegion("ID", -8.5, 115)).toBe("southeast-asia");
  });
});

describe("ensoImpact", () => {
  it("returns between 1 and 3 lines for every phase and region", () => {
    const samples: Array<[string | undefined, number, number]> = [
      ["ZW", -17.8, 31.0],
      ["KE", -1.3, 36.8],
      ["SG", 1.35, 103.8],
      ["GB", 51.5, -0.1],
      [undefined, 0, 0],
    ];
    for (const phase of PHASES) {
      for (const [cc, lat, lon] of samples) {
        const lines = ensoImpact(phase, cc, lat, lon);
        expect(lines.length).toBeGreaterThanOrEqual(1);
        expect(lines.length).toBeLessThanOrEqual(3);
        for (const line of lines) expect(line.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("gives El Niño southern-Africa guidance about drier, hotter conditions", () => {
    const text = ensoImpact("El Niño", "ZW", -17.8, 31.0).join(" ");
    expect(text).toContain("drier, hotter");
    expect(text).toContain("drought-tolerant seed");
    expect(text).toContain("water harvesting");
  });

  it("gives La Niña southern-Africa guidance about wetter conditions", () => {
    const text = ensoImpact("La Niña", "ZA", -26.2, 28.0).join(" ");
    expect(text).toContain("wetter conditions");
    expect(text).toContain("flood");
  });

  it("gives Angola and Madagascar the southern-Africa guidance", () => {
    expect(ensoImpact("El Niño", "AO", -12.3, 17.5).join(" ")).toContain(
      "drier, hotter",
    );
    expect(ensoImpact("El Niño", "MG", -18.9, 47.5).join(" ")).toContain(
      "drier, hotter",
    );
  });

  it("gives East Africa El Niño guidance about wetter short rains", () => {
    const text = ensoImpact("El Niño", "KE", -1.3, 36.8).join(" ");
    expect(text).toContain("wetter short rains");
    expect(text).toContain("flooding");
  });

  it("gives East Africa La Niña guidance about drier short rains", () => {
    const text = ensoImpact("La Niña", "TZ", -6.8, 39.3).join(" ");
    expect(text).toContain("drier short rains");
  });

  it("gives Southeast Asia El Niño guidance about drier conditions and haze", () => {
    const text = ensoImpact("El Niño", "ID", -2.5, 117.0).join(" ");
    expect(text).toContain("drier conditions");
    expect(text).toContain("haze");
  });

  it("gives Southeast Asia La Niña guidance about wetter conditions", () => {
    const text = ensoImpact("La Niña", "PH", 14.6, 121.0).join(" ");
    expect(text).toContain("wetter conditions");
  });

  it("gives Australia (AU) and Peru (PE) only the generic line", () => {
    const au = ensoImpact("El Niño", "AU", -33.9, 151.2);
    const pe = ensoImpact("El Niño", "PE", -12, -77);
    for (const lines of [au, pe]) {
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(GENERIC);
      expect(lines.join(" ")).not.toContain("southern Africa");
      expect(lines.join(" ")).not.toContain("drought-tolerant");
    }
  });

  it("gives Australia and Peru the generic line in La Niña too", () => {
    for (const [cc, lat, lon] of [
      ["AU", -33.9, 151.2],
      ["PE", -12, -77],
    ] as const) {
      const lines = ensoImpact("La Niña", cc, lat, lon);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(GENERIC);
    }
  });

  it("gives a generic line for regions without specific guidance", () => {
    const lines = ensoImpact("El Niño", "GB", 51.5, -0.1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(GENERIC);
  });

  it("returns the no-signal line for Neutral in every region", () => {
    for (const [cc, lat, lon] of [
      ["ZW", -17.8, 31.0],
      ["KE", -1.3, 36.8],
      ["SG", 1.35, 103.8],
      ["GB", 51.5, -0.1],
      ["AU", -33.9, 151.2],
    ] as const) {
      const lines = ensoImpact("Neutral", cc, lat, lon);
      expect(lines.join(" ")).toContain("No strong ENSO signal");
    }
  });

  it("hedges every line — never states an outcome as certain", () => {
    const forbidden = /\b(will|definitely|certainly|guarantee[sd]?)\b/i;
    for (const phase of PHASES) {
      for (const [cc, lat, lon] of [
        ["ZW", -17.8, 31.0],
        ["KE", -1.3, 36.8],
        ["SG", 1.35, 103.8],
        ["GB", 51.5, -0.1],
        ["AU", -33.9, 151.2],
      ] as const) {
        for (const line of ensoImpact(phase, cc, lat, lon)) {
          expect(line).not.toMatch(forbidden);
        }
      }
    }
  });

  it("returns a fresh array so callers cannot mutate the table", () => {
    const first = ensoImpact("El Niño", "ZW", -17.8, 31.0);
    first.push("tampered");
    const second = ensoImpact("El Niño", "ZW", -17.8, 31.0);
    expect(second).not.toContain("tampered");
  });
});
