import { describe, expect, it } from "vitest";
import { route, needsStores, type Deps, type Result } from "../src/handlers";
import {
  deviceStore,
  historyStore,
  placeAliasStore,
  placeView,
  reportStore,
  type Coll,
  type Doc,
} from "../src/stores";
import { validatePlaceQuery } from "../src/validate";
import { FakeColl } from "./fake";

// A placesGeo document as production holds one (windsor-avenue-zw, 2026-11-01).
const WINDSOR: Doc = {
  _id: "0c6749fa-8d0e-4df4-ad6d-7504ded4808c",
  name: "Windsor Avenue",
  slug: "windsor-avenue-00fc5a",
  geoType: "city",
  geo: {
    type: "Point",
    coordinates: [31.075910797793007, -17.810708454768136],
  },
  isoCode: "ZW",
  sourceProvenance: {
    dataOrigin: "mukoko_user",
    mukokoProvince: "Harare",
    mukokoElevation: 1493,
    mukokoSlug: "windsor-avenue-zw",
    mukokoTags: ["city"],
    mukokoNominatimAddress: { countryCode: "ZW", road: "Windsor Avenue" },
  },
};

function setup(places: Coll, now: () => number = () => 1_000) {
  const deps: Deps = {
    stores: {
      devices: deviceStore(new FakeColl(["deviceId"])),
      reports: reportStore(new FakeColl()),
      history: historyStore(new FakeColl()),
      places: placeAliasStore(places, now),
    },
    now: () => new Date("2026-11-01T10:00:00.000Z"),
    randomId: () => "id",
  };
  const get = (query: string): Promise<Result> =>
    route(
      {
        method: "GET",
        path: "/places",
        query: new URLSearchParams(query),
        body: undefined,
      },
      deps,
    );
  return { deps, get };
}

function collWith(docs: Doc[]): FakeColl {
  const c = new FakeColl();
  c.docs = docs.map((d) => structuredClone(d));
  return c;
}

describe("GET /places", () => {
  it("is a route that needs the stores", () => {
    expect(needsStores("/places")).toBe(true);
  });

  it("returns the community place stamped with the slug", async () => {
    const { get } = setup(collWith([WINDSOR]));
    const res = await get("slug=windsor-avenue-zw");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      place: {
        slug: "windsor-avenue-zw",
        name: "Windsor Avenue",
        lat: -17.810708454768136,
        lon: 31.075910797793007,
        elevation: 1493,
        province: "Harare",
        country: "ZW",
        tags: ["city"],
      },
    });
  });

  it("builds its own query: one equality on the stamped slug, nothing from the caller", async () => {
    const coll = collWith([WINDSOR]);
    const { get } = setup(coll);
    await get("slug=windsor-avenue-zw");
    expect(coll.calls).toEqual([
      {
        op: "findOne",
        filter: { "sourceProvenance.mukokoSlug": "windsor-avenue-zw" },
      },
    ]);
  });

  it("answers 404 for a slug nothing is stamped with", async () => {
    const { get } = setup(collWith([WINDSOR]));
    const res = await get("slug=nowhere-zw");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "not_found" });
  });

  it("refuses anything but exactly one valid slug before it reads", async () => {
    const coll = collWith([WINDSOR]);
    const { get } = setup(coll);
    for (const q of [
      "",
      "slug=",
      "slug=A_B",
      "slug=a&slug=b",
      "slug=%7B%22%24ne%22%3A1%7D",
      `slug=${"a".repeat(81)}`,
    ]) {
      const res = await get(q);
      expect(res.status, q).toBe(400);
    }
    expect(coll.calls).toEqual([]);
  });

  it("fails CLOSED when the read is not permitted: 503, never a 404", async () => {
    let asked = 0;
    const denied: Coll = {
      ...new FakeColl(),
      async findOne() {
        asked++;
        const e = new Error("not authorized on places to execute command");
        e.name = "MongoServerError";
        throw e;
      },
    } as unknown as Coll;
    let t = 1_000;
    const { get } = setup(denied, () => t);
    const first = await get("slug=windsor-avenue-zw");
    expect(first.status).toBe(503);
    expect(first.body).toMatchObject({ error: "unavailable" });
    // Asked once; for the next five minutes it does not ask again.
    t += 60_000;
    const second = await get("slug=church-road-zw");
    expect(second.status).toBe(503);
    expect(asked).toBe(1);
    // After the pause it asks again.
    t += 300_000;
    await get("slug=church-road-zw");
    expect(asked).toBe(2);
  });

  it("caches an answer, found for ten minutes and none for two", async () => {
    const coll = collWith([WINDSOR]);
    let t = 1_000;
    const { get } = setup(coll, () => t);
    await get("slug=windsor-avenue-zw");
    await get("slug=windsor-avenue-zw");
    await get("slug=nowhere-zw");
    await get("slug=nowhere-zw");
    expect(coll.calls).toHaveLength(2);
    t += 121_000;
    await get("slug=nowhere-zw");
    await get("slug=windsor-avenue-zw");
    expect(coll.calls).toHaveLength(3);
  });

  it("only GET is allowed", async () => {
    const { deps } = setup(collWith([WINDSOR]));
    const res = await route(
      {
        method: "POST",
        path: "/places",
        query: new URLSearchParams("slug=a"),
        body: {},
      },
      deps,
    );
    expect(res.status).toBe(405);
  });
});

describe("placeView", () => {
  it("drops a document that is not a place", () => {
    expect(placeView("x", { name: "", geo: WINDSOR.geo })).toBeNull();
    expect(placeView("x", { name: "A" })).toBeNull();
    for (const coordinates of [
      [200, 0],
      [0, 95],
      ["31", "-17"],
      [Number.NaN, 0],
      [1],
    ]) {
      expect(
        placeView("x", { name: "A", geo: { coordinates } }),
        JSON.stringify(coordinates),
      ).toBeNull();
    }
  });

  it("bounds and cleans what it passes on", () => {
    const view = placeView("x", {
      name: ` ${"n".repeat(200)} `,
      geo: { coordinates: [10, 20] },
      isoCode: "zw1",
      sourceProvenance: {
        mukokoElevation: 99_999,
        mukokoProvince: "p".repeat(200),
        mukokoTags: ["city", "Bad Tag", 5, ...Array(20).fill("farming")],
        mukokoNominatimAddress: { countryCode: "zw" },
      },
    })!;
    expect([...view.name]).toHaveLength(120);
    expect(view.elevation).toBeNull();
    expect([...view.province]).toHaveLength(80);
    // `isoCode` is not two letters: the address's code is used, upper-cased.
    expect(view.country).toBe("ZW");
    expect(view.tags).toHaveLength(10);
    expect(view.tags.every((t) => /^[a-z0-9-]+$/.test(t))).toBe(true);
  });

  it("reads a missing country as null, never a guess", () => {
    expect(
      placeView("x", { name: "A", geo: { coordinates: [1, 2] } })!.country,
    ).toBeNull();
  });
});

describe("validatePlaceQuery", () => {
  it("accepts exactly one valid slug", () => {
    expect(validatePlaceQuery(new URLSearchParams("slug=harare"))).toEqual({
      ok: true,
      value: { slug: "harare" },
    });
    expect(validatePlaceQuery(new URLSearchParams("")).ok).toBe(false);
    expect(validatePlaceQuery(new URLSearchParams("slug=a&slug=b")).ok).toBe(
      false,
    );
  });
});
