import { describe, expect, it, vi } from "vitest";
import {
  catalogueLocation,
  locationFromWorker,
  resolvePlaceSeed,
  seedFor,
  spotLocation,
} from "./place-resolve";

describe("resolvePlaceSeed", () => {
  it("answers a shipped place from the catalogue with no request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const seed = await resolvePlaceSeed("harare");
    expect(seed?.location.name).toBe("Harare");
    expect(seed?.countryName).toBe("Zimbabwe");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("asks the Worker for a place it does not ship", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          location: {
            slug: "mbare-musika",
            name: "Mbare Musika",
            province: "Harare",
            lat: -17.86,
            lon: 31.03,
            elevation: 1480,
            tags: ["market"],
            country: "ZW",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const seed = await resolvePlaceSeed("mbare-musika-abc123");
    expect(String(fetchSpy.mock.calls[0][0])).toContain(
      "/v1/locations?slug=mbare-musika-abc123",
    );
    expect(seed?.location.slug).toBe("mbare-musika-abc123");
    expect(seed?.location.name).toBe("Mbare Musika");
    fetchSpy.mockRestore();
  });

  it("builds a spot from its own slug when the Worker cannot be reached", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("offline"));
    // ksy4dd7 decodes to a point near Harare.
    const seed = await resolvePlaceSeed("west-paddock--ksy4dd7");
    expect(seed?.location.name).toBe("West Paddock");
    expect(seed?.location.elevationApproximate).toBe(true);
    expect(Number.isFinite(seed?.location.lat)).toBe(true);
    fetchSpy.mockRestore();
  });

  it("is null for a slug nothing can place", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 404 }));
    expect(await resolvePlaceSeed("nowhere-xx")).toBeNull();
    fetchSpy.mockRestore();
  });
});

describe("locations", () => {
  it("catalogueLocation / seedFor", () => {
    expect(catalogueLocation("nairobi-ke")?.country).toBe("KE");
    expect(catalogueLocation("nowhere-xx")).toBeNull();
    const s = seedFor(catalogueLocation("harare")!);
    expect(s.season.name.length).toBeGreaterThan(0);
  });

  it("spotLocation names an unnamed point by its coordinates", () => {
    const loc = spotLocation("place--ksy4dd7");
    expect(loc?.name).toMatch(/°[NS] .*°[EW]/);
    expect(spotLocation("harare")).toBeNull();
    expect(spotLocation("mall--osm-w123")).toBeNull();
  });

  it("locationFromWorker rejects unusable documents", () => {
    expect(locationFromWorker("x", null)).toBeNull();
    expect(locationFromWorker("x", { lat: "1", lon: 2 })).toBeNull();
    expect(locationFromWorker("x", { lat: 91, lon: 2 })).toBeNull();
    const loc = locationFromWorker("x", {
      lat: 1,
      lon: 2,
      elevation: 0,
      tags: ["a", 3],
    });
    expect(loc?.tags).toEqual(["a"]);
    expect(loc?.elevationApproximate).toBe(true);
    expect(loc?.name).toBe("Selected location");
  });
});
