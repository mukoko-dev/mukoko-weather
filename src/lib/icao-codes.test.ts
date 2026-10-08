import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getIcaoForSlug,
  getSlugForIcao,
  getNearestIcao,
  getNearestIcaos,
  getAirportByIcao,
  fetchNearestAirports,
  AIRPORTS,
  ICAO_MAP,
} from "./icao-codes";

describe("getIcaoForSlug", () => {
  it("returns correct ICAO for Zimbabwe locations", () => {
    expect(getIcaoForSlug("harare")).toBe("FVRG");
    expect(getIcaoForSlug("bulawayo")).toBe("FVBU");
    expect(getIcaoForSlug("victoria-falls")).toBe("FVFA");
    expect(getIcaoForSlug("masvingo")).toBe("FVMV");
    // Gweru and Mutare airports are not in the AWC station table — no METAR.
    expect(getIcaoForSlug("gweru")).toBeNull();
    expect(getIcaoForSlug("mutare")).toBeNull();
  });

  it("returns correct ICAO for global locations", () => {
    expect(getIcaoForSlug("nairobi-ke")).toBe("HKJK");
    expect(getIcaoForSlug("lagos-ng")).toBe("DNMM");
    expect(getIcaoForSlug("cairo-eg")).toBe("HECA");
    expect(getIcaoForSlug("johannesburg-za")).toBe("FAOR");
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
    expect(getSlugForIcao("FVRG")).toBe("harare");
    // FVHA is the retired code for Harare — no longer mapped.
    expect(getSlugForIcao("FVHA")).toBeNull();
    expect(getSlugForIcao("HKJK")).toBe("nairobi-ke");
  });

  it("is case-insensitive", () => {
    expect(getSlugForIcao("fvrg")).toBe("harare");
    expect(getSlugForIcao("FvRg")).toBe("harare");
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

  it("maps Chipinge to FVCH (Chinhoyi has no AWC station, so is unmapped)", () => {
    expect(getIcaoForSlug("chipinge")).toBe("FVCH");
    expect(getIcaoForSlug("chinhoyi")).toBeNull();
  });

  it("uses live METAR-reporting stations for Lusaka and Dakar", () => {
    // FLLS (Lusaka) and GOOY (Dakar-Yoff) are retired/closed codes.
    expect(getIcaoForSlug("lusaka-zm")).toBe("FLKK");
    expect(getIcaoForSlug("dakar-sn")).toBe("GOBD");
  });
});

describe("getAirportByIcao", () => {
  it("returns airport metadata for known codes", () => {
    const harare = getAirportByIcao("FVRG");
    expect(harare?.name).toContain("Harare");
    expect(harare?.lat).toBeCloseTo(-17.921, 3);
    expect(harare?.lon).toBeCloseTo(31.1, 3);
  });

  it("is case-insensitive", () => {
    expect(getAirportByIcao("fvrg")?.icao).toBe("FVRG");
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
});

describe("stale ICAO regression (AWC station table, 2026-10-08)", () => {
  it("FVRG (current Harare code) is present and FVHA (retired) is absent", () => {
    const codes = AIRPORTS.map((a) => a.icao);
    expect(codes).toContain("FVRG");
    expect(codes).not.toContain("FVHA");
  });

  it("FAOR (current Johannesburg O.R. Tambo code) is present and FAJS (retired) is absent", () => {
    const codes = AIRPORTS.map((a) => a.icao);
    expect(codes).toContain("FAOR");
    expect(codes).not.toContain("FAJS");
  });

  it("drops stations AWC does not list (no METAR can be served for them)", () => {
    const codes = new Set(AIRPORTS.map((a) => a.icao));
    for (const dead of [
      "FVGW",
      "FVMU",
      "FVGR",
      "FVKK",
      "FVBD",
      "FVCI",
      "FVBR",
      "FVCP",
    ]) {
      expect(codes.has(dead)).toBe(false);
    }
  });

  it("every ICAO slug mapping points at a catalogued airport", () => {
    const codes = new Set(AIRPORTS.map((a) => a.icao));
    for (const [slug, icao] of Object.entries(ICAO_MAP)) {
      expect(codes.has(icao), `${slug} → ${icao}`).toBe(true);
    }
  });
});

describe("getNearestIcao", () => {
  it("returns the closest airport for a point near Harare", () => {
    // A point a few km from Robert Gabriel Mugabe Intl.
    expect(getNearestIcao(-17.85, 31.05)).toBe("FVRG");
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
    expect(near[0].icao).toBe("FVRG");
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

describe("AIRPORTS (DB seed source)", () => {
  it("exports the airport catalog (AWC-listed stations only)", () => {
    expect(Array.isArray(AIRPORTS)).toBe(true);
    expect(AIRPORTS.length).toBeGreaterThanOrEqual(60);
  });

  it("uses AWC-verified coordinates for FVRG (within 1 km of the station)", () => {
    // AWC station info: FVRG -17.921, 31.1
    const a = getAirportByIcao("FVRG");
    expect(a?.lat).toBeCloseTo(-17.921, 3);
    expect(a?.lon).toBeCloseTo(31.1, 3);
  });

  it("every airport has a 4-letter ICAO, name, and valid WGS 84 coords", () => {
    for (const a of AIRPORTS) {
      expect(a.icao).toMatch(/^[A-Z]{4}$/);
      expect(a.name.length).toBeGreaterThan(0);
      expect(a.lat).toBeGreaterThanOrEqual(-90);
      expect(a.lat).toBeLessThanOrEqual(90);
      expect(a.lon).toBeGreaterThanOrEqual(-180);
      expect(a.lon).toBeLessThanOrEqual(180);
    }
  });

  it("has unique ICAO codes (safe as a natural _id for upsert seeding)", () => {
    const codes = AIRPORTS.map((a) => a.icao);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("fetchNearestAirports (DB-backed with static fallback)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns the DB result when the API responds with airports", async () => {
    const dbResult = [
      { icao: "FVHA", name: "Harare", distanceKm: 12.3 },
      { icao: "FVCP", name: "Charles Prince", distanceKm: 20.1 },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ airports: dbResult }),
      }),
    );
    const result = await fetchNearestAirports(-17.85, 31.05, 5);
    expect(result).toEqual(dbResult);
  });

  it("falls back to the static haversine scan when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    const result = await fetchNearestAirports(-17.85, 31.05, 3);
    // Static fallback still finds Harare closest.
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].icao).toBe("FVRG");
  });

  it("falls back to static when the DB returns an empty list", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ airports: [] }) }),
    );
    const result = await fetchNearestAirports(-17.85, 31.05, 3);
    expect(result[0].icao).toBe("FVRG");
  });

  it("falls back to static on a non-OK HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    const result = await fetchNearestAirports(-17.85, 31.05, 3);
    expect(result[0].icao).toBe("FVRG");
  });
});
