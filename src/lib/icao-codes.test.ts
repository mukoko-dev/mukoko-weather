import { describe, it, expect } from "vitest";
import { getIcaoForSlug } from "./icao-codes";

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

  it("all ICAO codes are 4 uppercase letters", () => {
    const slugs = [
      "harare", "bulawayo", "victoria-falls", "nairobi-ke",
      "lagos-ng", "cairo-eg", "singapore-sg",
    ];
    for (const slug of slugs) {
      const code = getIcaoForSlug(slug);
      expect(code).toMatch(/^[A-Z]{4}$/);
    }
  });
});
