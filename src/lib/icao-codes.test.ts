import { describe, it, expect } from "vitest";
import { getIcaoForSlug, getSlugForIcao, ICAO_MAP } from "./icao-codes";

describe("getIcaoForSlug", () => {
  it("returns ICAO code for known ZW locations", () => {
    expect(getIcaoForSlug("harare")).toBe("FVHA");
    expect(getIcaoForSlug("bulawayo")).toBe("FVBU");
    expect(getIcaoForSlug("victoria-falls")).toBe("FVFA");
    expect(getIcaoForSlug("masvingo")).toBe("FVMV");
  });
  it("returns ICAO code for global locations", () => {
    expect(getIcaoForSlug("nairobi-ke")).toBe("HKJK");
    expect(getIcaoForSlug("johannesburg-za")).toBe("FAJS");
    expect(getIcaoForSlug("singapore-sg")).toBe("WSSS");
  });
  it("returns null for unknown slugs", () => {
    expect(getIcaoForSlug("unknown-location")).toBeNull();
    expect(getIcaoForSlug("")).toBeNull();
    expect(getIcaoForSlug("some-small-village")).toBeNull();
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
  it("has entries for ZW airports", () => {
    expect(Object.keys(ICAO_MAP).length).toBeGreaterThan(10);
  });
  it("all ICAO codes are 4 characters uppercase", () => {
    for (const code of Object.values(ICAO_MAP)) {
      expect(code).toMatch(/^[A-Z]{4}$/);
    }
  });
});
