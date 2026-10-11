import { describe, it, expect } from "vitest";
import { ipFallbackLocation } from "./home-location";
import { parseSmartSlug } from "./smart-slug";

describe("ipFallbackLocation — home seed for visitors outside the stored geography", () => {
  it("gives a London visitor London, not an empty chooser", () => {
    const loc = ipFallbackLocation(51.5074, -0.1278, "GB", "London");
    expect(loc).not.toBeNull();
    expect(loc!.name).toBe("London");
    expect(loc!.country).toBe("GB");
    const parsed = parseSmartSlug(loc!.slug);
    expect(parsed?.ref.kind).toBe("spot");
  });

  it("decodes Vercel's URL-encoded city header", () => {
    expect(
      ipFallbackLocation(-23.55, -46.63, "BR", "S%C3%A3o%20Paulo")!.name,
    ).toBe("São Paulo");
  });

  it("still uses a nearby shipped seed in the visitor's own country", () => {
    const loc = ipFallbackLocation(-17.85, 31.06, "ZW", "Harare");
    expect(loc!.slug).toBe("harare");
  });

  it("never borrows a seed across a border", () => {
    // Málaga is within 250 km of the Tangier seed (Morocco).
    const loc = ipFallbackLocation(36.72, -4.42, "ES", "Malaga");
    expect(loc!.country).toBe("ES");
    expect(loc!.name).toBe("Malaga");
  });

  it("names an unnamed position generically and rejects junk", () => {
    expect(ipFallbackLocation(-30, -140, null, null)!.name).toBe("My location");
    expect(ipFallbackLocation(Number.NaN, 0, "GB", "x")).toBeNull();
  });
});
