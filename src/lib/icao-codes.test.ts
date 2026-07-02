import { describe, it, expect } from "vitest";
import {
  getIcaoForSlug,
  getSlugForIcao,
  getNearestIcao,
  getNearestIcaos,
  getAirportByIcao,
  ICAO_MAP,
} from "./icao-codes";

describe("getIcaoForSlug", () => {
  it("returns correct ICAO for Zimbabwe locations", () => {
    expect(getIcaoForSlug("harare")).toBe("FVHA");
    expect(getIcaoForSlug("bulawayo")).toBe("FVBU");
    expect(getIcaoForSlug("victoria-falls")).toBe("FVFA");
    expect(getIcaoForSlug("masvingo")).toBe("FVMV");
    expect(getIcaoForSlug("gweru")).toBe("FVGW");
    expect(getIcaoForSlug("mutare")).toBe("FVMU");
  });

  it("returns correct ICAO for global locations", () => {
    expect(getIcaoForSlug("nairobi-ke")).toBe("HKJK");
    expect(getIcaoForSlug("lagos-ng")).toBe("DNMM");
    expect(getIcaoForSlug("cairo-eg")).toBe("HECA");
    expect(getIcaoForSlug("johannesburg-za")).toBe("FAJS");
    expect(getIcaoForSlug("singapore-sg")).toBe("WSSS");
    expect(getIcaoForSlug("bangkok-th")).toBe("VTBS");
  });

  it("returns null for unknown slugs", () => {
    expect(getIcaoForSlug("unknown-city")).toBeNull();
    expect(getIcaoForSlug("")).toBeNull();
    expect(getIcaoForSlug("some-random-place")).toBeNull();
  });

  it("is case-sensitive — slugs must be lowercase", () => {
    expect(getIcaoForSlug("Harare")).toBeNull();
    expect(getIcaoForSlug("HARARE")).toBeNull();
  });
});

describe("getSlugForIcao", () => {
  it("returns slug for known ICAO codes", () => {
    expect(getSlugForIcao("FVHA")).toBe("harare");
    expect(getSlugForIcao("HKJK")).toBe("nairobi-ke");
  });

  it("is case-insensitive", () => {
    expect(getSlugForIcao("fvha")).toBe("harare");
    expect(getSlugForIcao("FvHa")).toBe("harare");
  });

  it("returns null for unknown codes", () => {
    expect(getSlugForIcao("ZZZZ")).toBeNull();
  });
});

describe("ICAO_MAP", () => {
  it("has entries for ZW and global airports", () => {
    expect(Object.keys(ICAO_MAP).length).toBeGreaterThan(10);
  });

  it("all ICAO codes are 4 uppercase letters", () => {
    for (const code of Object.values(ICAO_MAP)) {
      expect(code).toMatch(/^[A-Z]{4}$/);
    }
  });

  it("maps expanded Southern-African locations", () => {
    expect(getIcaoForSlug("gaborone-bw")).toBe("FBSK");
    expect(getIcaoForSlug("windhoek-na")).toBe("FYWH");
    expect(getIcaoForSlug("lilongwe-mw")).toBe("FWKI");
    expect(getIcaoForSlug("durban-za")).toBe("FALE");
  });

  it("corrects Chinhoyi/Chipinge ICAO mix-up", () => {
    // FVCH is actually Chipinge; Chinhoyi's real ICAO is FVCI.
    expect(getIcaoForSlug("chinhoyi")).toBe("FVCI");
    expect(getIcaoForSlug("chipinge")).toBe("FVCH");
  });

  it("uses live METAR-reporting stations for Lusaka and Dakar", () => {
    // FLLS (Lusaka) and GOOY (Dakar-Yoff) are retired/closed codes.
    expect(getIcaoForSlug("lusaka-zm")).toBe("FLKK");
    expect(getIcaoForSlug("dakar-sn")).toBe("GOBD");
  });
});

describe("getAirportByIcao", () => {
  it("returns airport metadata for known codes", () => {
    const harare = getAirportByIcao("FVHA");
    expect(harare?.name).toContain("Harare");
    expect(harare?.lat).toBeCloseTo(-17.932, 2);
    expect(harare?.lon).toBeCloseTo(31.093, 2);
  });

  it("is case-insensitive", () => {
    expect(getAirportByIcao("fvha")?.icao).toBe("FVHA");
  });

  it("returns null for unknown codes", () => {
    expect(getAirportByIcao("ZZZZ")).toBeNull();
  });
});

describe("corrected airport coordinates", () => {
  it("fixes Beitbridge longitude (was ~29.43, should be ~30.0)", () => {
    const bb = getAirportByIcao("FVBB");
    expect(bb?.lon).toBeGreaterThan(29.9);
    expect(bb?.lon).toBeCloseTo(30.013, 1);
  });

  it("fixes Bindura latitude (was ~-17.17, should be ~-17.30)", () => {
    const bd = getAirportByIcao("FVBD");
    expect(bd?.lat).toBeCloseTo(-17.304, 1);
  });

  it("fixes Kwekwe longitude", () => {
    const kk = getAirportByIcao("FVKK");
    expect(kk?.lon).toBeCloseTo(29.841, 1);
  });
});

describe("getNearestIcao", () => {
  it("returns the closest airport for a point near Harare", () => {
    // A point a few km from Robert Gabriel Mugabe Intl.
    expect(getNearestIcao(-17.85, 31.05)).toBe("FVHA");
  });

  it("returns null when nothing is within range", () => {
    // Middle of the South Atlantic — no airport within 150km.
    expect(getNearestIcao(-40, -20)).toBeNull();
  });
});

describe("getNearestIcaos", () => {
  it("returns up to N airports sorted closest-first", () => {
    const near = getNearestIcaos(-17.85, 31.05, 3);
    expect(near.length).toBeGreaterThan(0);
    expect(near.length).toBeLessThanOrEqual(3);
    expect(near[0].icao).toBe("FVHA");
    // distances must be non-decreasing
    for (let i = 1; i < near.length; i++) {
      expect(near[i].distanceKm).toBeGreaterThanOrEqual(near[i - 1].distanceKm);
    }
  });

  it("includes name and distance for each result", () => {
    const [first] = getNearestIcaos(-17.85, 31.05, 1);
    expect(first.name).toContain("Harare");
    expect(typeof first.distanceKm).toBe("number");
    expect(first.distanceKm).toBeGreaterThanOrEqual(0);
  });

  it("respects the maxDistanceKm filter", () => {
    expect(getNearestIcaos(-40, -20, 5, 150)).toHaveLength(0);
  });
});
