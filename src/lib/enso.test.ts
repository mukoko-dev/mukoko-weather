import { describe, it, expect } from "vitest";
import { ensoImpact, ensoRegion, type EnsoPhase } from "./enso";

const PHASES: EnsoPhase[] = ["El Niño", "La Niña", "Neutral"];

describe("ensoRegion", () => {
  it("maps southern African countries to southern-africa", () => {
    for (const cc of ["ZW", "ZA", "ZM", "MZ", "MW", "BW", "NA", "LS", "SZ"]) {
      expect(ensoRegion(cc, -17.8)).toBe("southern-africa");
    }
  });

  it("maps East African countries to east-africa", () => {
    for (const cc of ["KE", "TZ", "UG", "ET", "RW", "BI", "SO"]) {
      expect(ensoRegion(cc, 0)).toBe("east-africa");
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
      expect(ensoRegion(cc, 1)).toBe("southeast-asia");
    }
  });

  it("is case-insensitive on the country code", () => {
    expect(ensoRegion("zw", -17.8)).toBe("southern-africa");
  });

  it("uses the latitude rule (lat < -8) for unlisted countries", () => {
    expect(ensoRegion(undefined, -8.5)).toBe("southern-africa");
  });

  it("does not apply the latitude rule at exactly -8", () => {
    expect(ensoRegion(undefined, -8)).toBe("other");
  });

  it("returns other for northern, unlisted locations", () => {
    expect(ensoRegion("GB", 51.5)).toBe("other");
    expect(ensoRegion(undefined, 10)).toBe("other");
  });

  it("returns other for non-finite latitude without a listed country", () => {
    expect(ensoRegion(undefined, Number.NaN)).toBe("other");
  });

  it("lets a listed country win over the latitude rule", () => {
    // Tanzania's south sits below -8, but it is an East Africa country.
    expect(ensoRegion("TZ", -9.5)).toBe("east-africa");
    // Indonesia sits near the equator and below -8 in Java/Timor.
    expect(ensoRegion("ID", -8.5)).toBe("southeast-asia");
  });
});

describe("ensoImpact", () => {
  it("returns between 1 and 3 lines for every phase and region", () => {
    const samples: Array<[string | undefined, number]> = [
      ["ZW", -17.8],
      ["KE", -1.3],
      ["SG", 1.35],
      ["GB", 51.5],
      [undefined, 0],
    ];
    for (const phase of PHASES) {
      for (const [cc, lat] of samples) {
        const lines = ensoImpact(phase, cc, lat);
        expect(lines.length).toBeGreaterThanOrEqual(1);
        expect(lines.length).toBeLessThanOrEqual(3);
        for (const line of lines) expect(line.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("gives El Niño southern-Africa guidance about drier, hotter conditions", () => {
    const text = ensoImpact("El Niño", "ZW", -17.8).join(" ");
    expect(text).toContain("drier, hotter");
    expect(text).toContain("drought-tolerant seed");
    expect(text).toContain("water harvesting");
  });

  it("gives La Niña southern-Africa guidance about wetter conditions", () => {
    const text = ensoImpact("La Niña", "ZA", -26.2).join(" ");
    expect(text).toContain("wetter conditions");
    expect(text).toContain("flood");
  });

  it("gives East Africa El Niño guidance about wetter short rains", () => {
    const text = ensoImpact("El Niño", "KE", -1.3).join(" ");
    expect(text).toContain("wetter short rains");
    expect(text).toContain("flooding");
  });

  it("gives East Africa La Niña guidance about drier short rains", () => {
    const text = ensoImpact("La Niña", "TZ", -6.8).join(" ");
    expect(text).toContain("drier short rains");
  });

  it("gives Southeast Asia El Niño guidance about drier conditions and haze", () => {
    const text = ensoImpact("El Niño", "ID", -2.5).join(" ");
    expect(text).toContain("drier conditions");
    expect(text).toContain("haze");
  });

  it("gives Southeast Asia La Niña guidance about wetter conditions", () => {
    const text = ensoImpact("La Niña", "PH", 14.6).join(" ");
    expect(text).toContain("wetter conditions");
  });

  it("gives a generic line for regions without specific guidance", () => {
    const lines = ensoImpact("El Niño", "GB", 51.5);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("effects vary locally");
  });

  it("returns the no-signal line for Neutral in every region", () => {
    for (const [cc, lat] of [
      ["ZW", -17.8],
      ["KE", -1.3],
      ["SG", 1.35],
      ["GB", 51.5],
    ] as const) {
      const lines = ensoImpact("Neutral", cc, lat);
      expect(lines.join(" ")).toContain("No strong ENSO signal");
    }
  });

  it("hedges every line — never states an outcome as certain", () => {
    const forbidden = /\b(will|definitely|certainly|guarantee[sd]?)\b/i;
    for (const phase of PHASES) {
      for (const [cc, lat] of [
        ["ZW", -17.8],
        ["KE", -1.3],
        ["SG", 1.35],
        ["GB", 51.5],
      ] as const) {
        for (const line of ensoImpact(phase, cc, lat)) {
          expect(line).not.toMatch(forbidden);
        }
      }
    }
  });

  it("returns a fresh array so callers cannot mutate the table", () => {
    const first = ensoImpact("El Niño", "ZW", -17.8);
    first.push("tampered");
    const second = ensoImpact("El Niño", "ZW", -17.8);
    expect(second).not.toContain("tampered");
  });
});
