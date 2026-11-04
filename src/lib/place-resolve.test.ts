import { readFileSync } from "fs";
import { resolve } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workerData } from "./worker-data";
import {
  catalogueLocation,
  locationFromWorker,
  lookupPlace,
  resolvePlaceSeed,
  seedFor,
  spotLocation,
} from "./place-resolve";

describe("resolvePlaceSeed", () => {
  beforeEach(() => workerData.reset());

  it("reads the Worker through the shared fetch store, never a raw fetchWorker call", () => {
    const source = readFileSync(
      resolve(__dirname, "place-resolve.ts"),
      "utf-8",
    );
    expect(source).toContain("workerData.read<{ location?: WorkerLocation }>(");
    expect(source).toContain('"locations"');
    expect(source).not.toContain("fetchWorker");
  });

  it("asks once for the same slug, however many times it is switched to", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          location: { slug: "x-one", name: "X One", lat: 1, lon: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await Promise.all([
      resolvePlaceSeed("x-one-abc123"),
      resolvePlaceSeed("x-one-abc123"),
    ]);
    await resolvePlaceSeed("x-one-abc123");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

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

describe("lookupPlace: what the browser learns about a slug the server did not name (#452)", () => {
  beforeEach(() => workerData.reset());

  const WORKER_PLACE = {
    location: {
      slug: "sembawang-sg",
      name: "Sembawang",
      province: "Singapore",
      lat: 1.45,
      lon: 103.82,
      elevation: 15,
      tags: ["city"],
      country: "SG",
    },
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("a shipped place and a spot need no request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const shipped = await lookupPlace("harare");
    expect(shipped.kind).toBe("found");
    const spot = await lookupPlace("west-paddock--ksy4dd7");
    expect(spot.kind).toBe("found");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("is found for a place the Worker holds", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json(WORKER_PLACE));
    const result = await lookupPlace("sembawang-sg");
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.seed.location.name).toBe("Sembawang");
    }
    fetchSpy.mockRestore();
  });

  it("is missing when the Worker answers that there is no such place (404)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ error: "not found" }, 404));
    expect(await lookupPlace("zzzz-not-a-place")).toEqual({ kind: "missing" });
    fetchSpy.mockRestore();
  });

  it("is missing for an answer with no usable coordinate", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ location: { name: "No coordinates" } }));
    expect(await lookupPlace("nowhere-xx")).toEqual({ kind: "missing" });
    fetchSpy.mockRestore();
  });

  it("is unavailable, never 'missing', when the Worker fails or cannot be reached", async () => {
    // A server error, then no connection: neither says anything about the place.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ error: "boom" }, 503));
    expect(await lookupPlace("sembawang-sg")).toEqual({ kind: "unavailable" });
    workerData.reset();
    fetchSpy.mockRejectedValue(new Error("offline"));
    expect(await lookupPlace("sembawang-sg")).toEqual({ kind: "unavailable" });
    workerData.reset();
    // Too many requests is a limit, not an absence.
    fetchSpy.mockResolvedValue(json({ error: "slow down" }, 429));
    expect(await lookupPlace("sembawang-sg")).toEqual({ kind: "unavailable" });
    fetchSpy.mockRestore();
  });

  it("'Try again' (force) reads past the failure the shared read remembers", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: "boom" }, 503))
      .mockResolvedValueOnce(json({ error: "boom" }, 503))
      .mockResolvedValue(json(WORKER_PLACE));
    expect(await lookupPlace("sembawang-sg")).toEqual({ kind: "unavailable" });
    // Remembered: asking again without force replays the failure.
    expect(await lookupPlace("sembawang-sg")).toEqual({ kind: "unavailable" });
    const again = await lookupPlace("sembawang-sg", undefined, { force: true });
    expect(again.kind).toBe("found");
    fetchSpy.mockRestore();
  });

  it("is unavailable when the caller stops waiting", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = lookupPlace("sembawang-sg", controller.signal);
    controller.abort();
    expect(await pending).toEqual({ kind: "unavailable" });
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
