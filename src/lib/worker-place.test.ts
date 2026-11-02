import { describe, it, expect, vi } from "vitest";
import { fetchWorkerPlace, looksLikePlaceSlug } from "./worker-place";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const SEMBAWANG = {
  location: {
    country: "SG",
    elevation: 8.0,
    lat: 1.4439557246543009,
    lon: 103.8244683875342,
    name: "Sembawang",
    province: "Sembawang",
    provinceSlug: "sembawang-sg",
    slug: "sembawang-sg",
    source: "community",
    tags: ["city"],
  },
};

describe("fetchWorkerPlace (the Worker's /v1/locations?slug=)", () => {
  it("adapts a place the Worker knows, keeping the slug the visitor asked for", async () => {
    const fetcher = vi.fn(async () => json(SEMBAWANG));
    const place = await fetchWorkerPlace("sembawang-sg", { fetcher });
    expect(place).toMatchObject({
      slug: "sembawang-sg",
      name: "Sembawang",
      country: "SG",
      source: "community",
      _id: "worker:sembawang-sg",
    });
    expect(place?.lat).toBeCloseTo(1.444, 3);
    const url = String((fetcher.mock.calls[0] as unknown[])[0]);
    expect(url).toBe(
      "https://weather-api.mukoko.com/v1/locations?slug=sembawang-sg",
    );
  });

  it("is null for a place the Worker does not know (404), not an error", async () => {
    const fetcher = vi.fn(async () =>
      json(
        { error: "not_found", error_description: "Location not found" },
        404,
      ),
    );
    expect(await fetchWorkerPlace("london-gb", { fetcher })).toBeNull();
  });

  it("throws when the Worker could not answer, so the caller can tell unknown from failed", async () => {
    await expect(
      fetchWorkerPlace("sembawang-sg", {
        fetcher: vi.fn(async () => json({}, 503)),
      }),
    ).rejects.toThrow();
    await expect(
      fetchWorkerPlace("sembawang-sg", {
        fetcher: vi.fn(async () => {
          throw new TypeError("Failed to fetch");
        }),
      }),
    ).rejects.toThrow();
  });

  it("refuses a body that is not that place (wrong slug, no coordinates)", async () => {
    for (const body of [
      { location: { ...SEMBAWANG.location, slug: "somewhere-else" } },
      { location: { ...SEMBAWANG.location, lat: "x" } },
      { location: { ...SEMBAWANG.location, name: "" } },
      {},
      { locations: [] },
    ]) {
      expect(
        await fetchWorkerPlace("sembawang-sg", {
          fetcher: vi.fn(async () => json(body)),
        }),
      ).toBeNull();
    }
  });

  it("gives up after its time limit", async () => {
    const fetcher = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    ) as unknown as typeof fetch;
    await expect(
      fetchWorkerPlace("sembawang-sg", { fetcher, timeoutMs: 20 }),
    ).rejects.toThrow();
  });
});

describe("looksLikePlaceSlug (what is worth a Worker lookup)", () => {
  it("accepts ordinary place slugs", () => {
    for (const s of [
      "sembawang-sg",
      "london-gb",
      "koh-samui",
      "harare-a1b2c3",
    ]) {
      expect(looksLikePlaceSlug(s), s).toBe(true);
    }
  });
  it("refuses probes, junk and over-long slugs, so scanners never reach the Worker", () => {
    for (const s of [
      "",
      "ab",
      "wp-login",
      "admin",
      "x_y",
      "UPPER",
      "a".repeat(81),
      "12345",
      "../etc",
    ]) {
      expect(looksLikePlaceSlug(s), s).toBe(false);
    }
  });
});
