import { describe, expect, it } from "vitest";
import { route, type Deps, type Result } from "../src/handlers";
import {
  aliasBases,
  deviceStore,
  historyStore,
  isAliasOf,
  placeAliasStore,
  reportStore,
  type Coll,
} from "../src/stores";
import {
  validateHistoryRead,
  validateHistoryWrite,
  validHistoryKey,
} from "../src/validate";
import { FakeColl } from "./fake";

const NOW = new Date("2026-10-31T12:00:00.000Z");

/** A placesGeo record, as the platform stores it. */
const place = (
  slug: string,
  lat: number,
  lon: number,
  geoType = "city",
): Record<string, unknown> => ({
  _id: `id-${slug}`,
  slug,
  name: slug.replace(/-[0-9a-f]{6}$/, ""),
  geoType,
  geo: { type: "Point", coordinates: [lon, lat] },
});

function setup(placesDocs: Record<string, unknown>[] = [], places?: Coll) {
  const history = new FakeColl();
  const placesColl = new FakeColl();
  placesColl.docs.push(...placesDocs);
  let clock = 1_000_000;
  const aliasStore = placeAliasStore(places ?? placesColl, () => clock);
  const deps: Deps = {
    stores: {
      devices: deviceStore(new FakeColl(["deviceId"])),
      reports: reportStore(new FakeColl()),
      history: historyStore(history),
      places: aliasStore,
    },
    now: () => NOW,
    randomId: () => "id",
  };
  const call = (
    method: string,
    path: string,
    body?: unknown,
    query = "",
  ): Promise<Result> =>
    route({ method, path, query: new URLSearchParams(query), body }, deps);
  return {
    history,
    places: placesColl,
    call,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const day = (date: string, over: Record<string, unknown> = {}) => ({
  date,
  source: "nasa-power",
  current: {
    temperature_2m: 26.5,
    relative_humidity_2m: 34,
    uv_index: null,
    is_day: 1,
  },
  daily: {
    time: [date],
    temperature_2m_max: [32.1],
    temperature_2m_min: [20.8],
    weather_code: [null],
    sunrise: ["2026-10-28T05:19"],
    sunset: ["2026-10-28T18:00"],
  },
  insights: { dewPoint: 8.6 },
  ...over,
});

describe("history keys", () => {
  it("accepts a place, a spot cell and a coordinate cell, nothing else", () => {
    for (const k of [
      "harare",
      "nairobi-ke",
      "geo:gcpvj0e",
      "cell:-17.85_31.05",
      "cell:51.50_-0.10",
    ])
      expect(validHistoryKey(k), k).toBe(true);
    for (const k of [
      "",
      "Harare",
      "cell:1_2",
      "cell:-17.85_31.05/../x",
      "geo:ab",
      "$where",
      "a b",
    ])
      expect(validHistoryKey(k), k).toBe(false);
  });
});

describe("GET /history", () => {
  it("validates the query", async () => {
    const { call } = setup();
    const status = async (q: string) =>
      (await call("GET", "/history", undefined, q)).status;
    expect(await status("")).toBe(400);
    expect(await status("slug=harare")).toBe(400);
    expect(await status("slug=harare&start=2026-10-01&end=2026-13-01")).toBe(
      400,
    );
    expect(await status("slug=harare&start=1939-12-31&end=2026-10-01")).toBe(
      400,
    );
    expect(await status("slug=harare&start=2026-10-02&end=2026-10-01")).toBe(
      400,
    );
    expect(await status("slug=harare&start=2010-01-01&end=2026-10-01")).toBe(
      400,
    );
    expect(
      await status(
        "slug=a&slug=b&slug=c&slug=d&start=2026-10-01&end=2026-10-02",
      ),
    ).toBe(400);
    expect(await status("slug=%24where&start=2026-10-01&end=2026-10-02")).toBe(
      400,
    );
    expect(await status("slug=harare&start=2016-11-01&end=2026-10-31")).toBe(
      200,
    );
  });

  it("returns the range newest first, with legacy documents read as recorded", async () => {
    const { history, call } = setup();
    history.docs.push(
      {
        _id: "1",
        locationSlug: "harare",
        date: "2026-10-18",
        source: "recorded",
        recordedAt: new Date("2026-10-18T14:00:00Z"),
        current: { temperature_2m: 20 },
        daily: { time: ["2026-10-18"] },
      },
      {
        _id: "2",
        locationSlug: "harare",
        date: "2026-10-09",
        source: "open-meteo-archive",
        recordedAt: new Date("2026-10-10T10:27:10Z"),
        current: {},
        daily: {},
      },
      {
        _id: "3",
        locationSlug: "harare",
        date: "2026-07-01",
        recordedAt: new Date("2026-07-01T00:00:00Z"),
        current: {},
        daily: {},
      },
      { _id: "4", locationSlug: "harare", recordedAt: new Date() }, // no date
      {
        _id: "5",
        locationSlug: "nairobi-ke",
        date: "2026-10-18",
        source: "recorded",
      },
    );
    const r = await call(
      "GET",
      "/history",
      undefined,
      "slug=harare&start=2026-07-01&end=2026-10-31",
    );
    expect(r.status).toBe(200);
    const days = (r.body as { days: Record<string, unknown>[] }).days;
    expect(days.map((d) => d.date)).toEqual([
      "2026-10-18",
      "2026-10-09",
      "2026-07-01",
    ]);
    expect(days[0]!.recordedAt).toBe("2026-10-18T14:00:00.000Z");
    expect(days[2]!.source).toBe("recorded");
    expect(days.every((d) => d.locationSlug === "harare")).toBe(true);
    expect(days[0]).not.toHaveProperty("_id");
  });

  describe("platform aliases (found from the place record)", () => {
    const NAIROBI = { lat: -1.2864, lon: 36.8172 };
    const nairobiQuery = `slug=nairobi-ke&start=2026-10-01&end=2026-10-31&aliases=1&lat=${NAIROBI.lat}&lon=${NAIROBI.lon}`;
    const records = [
      place("nairobi-518dd4", -1.2814, 36.81471), // the city
      place("nairobi-a84754", -1.29, 36.82, "province"), // a province of that name
      place("nairobi-ffffff", -1.3, 36.85, "town"), // same name, a town record
      place("nairobi-eeeeee", 6.44, 3.39), // same name 5,000 km away
      place("nairobi-west-abcdef", -1.3, 36.8), // another name, near
      place("kisumu-ba53b7", -0.1, 34.76), // far
    ];
    const hist = (slug: string, date: string, id: string) => ({
      _id: id,
      locationSlug: slug,
      date,
      source: "recorded",
    });

    it("finds the city and town records of that name near the point", async () => {
      const { history, call } = setup(records);
      history.docs.push(
        hist("nairobi-ke", "2026-10-18", "1"),
        hist("nairobi-518dd4", "2026-10-31", "2"),
        hist("nairobi-ffffff", "2026-10-30", "3"),
        hist("nairobi-a84754", "2026-10-29", "4"), // the province
        hist("nairobi-eeeeee", "2026-10-28", "5"), // another place
        hist("nairobi-west-abcdef", "2026-10-27", "6"),
      );
      const r = await call("GET", "/history", undefined, nairobiQuery);
      expect(r.status).toBe(200);
      const days = (
        r.body as { days: { date: string; locationSlug: string }[] }
      ).days;
      expect(days.map((d) => d.locationSlug)).toEqual([
        "nairobi-518dd4",
        "nairobi-ffffff",
        "nairobi-ke",
      ]);
      // The history query itself is plain `$in` over validated slugs: no regex.
      const q = history.calls.find((c) => c.op === "findMany")!;
      expect(q.filter).toEqual({
        locationSlug: {
          $in: ["nairobi-ke", "nairobi-518dd4", "nairobi-ffffff"],
        },
        date: { $gte: "2026-10-01", $lte: "2026-10-31" },
      });
      expect(JSON.stringify(q.filter)).not.toContain("$regex");
    });

    it("works for a plain catalogue slug (harare) and for the slug alone", async () => {
      const { history, call } = setup([
        place("harare-35c223", -17.81584, 31.04276),
      ]);
      history.docs.push(
        hist("harare", "2026-10-18", "1"),
        hist("harare-35c223", "2026-10-17", "2"),
        hist("harare-abcdef", "2026-10-16", "3"), // no placesGeo record: not ours
        hist("harare-cafe", "2026-10-15", "4"), // not six hex digits
        hist("harare-zw-35c223", "2026-10-14", "5"), // another slug
      );
      const q = "slug=harare&start=2026-10-01&end=2026-10-31";
      const plain = await call("GET", "/history", undefined, q);
      expect(
        (plain.body as { days: { date: string }[] }).days.map((d) => d.date),
      ).toEqual(["2026-10-18"]);
      const r = await call(
        "GET",
        "/history",
        undefined,
        `${q}&aliases=1&lat=-17.8292&lon=31.0522`,
      );
      expect(
        (r.body as { days: { locationSlug: string }[] }).days.map(
          (d) => d.locationSlug,
        ),
      ).toEqual(["harare", "harare-35c223"]);
    });

    it("does not merge two places that share a name", async () => {
      // placesGeo holds a Nyanga town in Zimbabwe and a Nyanga province in
      // Gabon: only the one near the requested point is this place's alias.
      const { history, call } = setup([
        place("nyanga-e2657a", -18.2167, 32.7667, "town"),
        place("nyanga-def0f2", -2.9, 10.9, "town"),
      ]);
      history.docs.push(
        hist("nyanga", "2026-10-18", "1"),
        hist("nyanga-e2657a", "2026-10-17", "2"),
        hist("nyanga-def0f2", "2026-10-16", "3"),
      );
      const r = await call(
        "GET",
        "/history",
        undefined,
        "slug=nyanga&start=2026-10-01&end=2026-10-31&aliases=1&lat=-18.2167&lon=32.7667",
      );
      expect(
        (r.body as { days: { locationSlug: string }[] }).days.map(
          (d) => d.locationSlug,
        ),
      ).toEqual(["nyanga", "nyanga-e2657a"]);
    });

    it("reads placesGeo and never writes it", async () => {
      const { places, call } = setup(records);
      await call("GET", "/history", undefined, nairobiQuery);
      expect(places.calls.map((c) => c.op)).toEqual(["findMany"]);
      const q = places.calls[0]!;
      expect(q.filter).toMatchObject({
        geoType: { $in: ["city", "town", "village"] },
      });
      const options = q.options as { projection: Record<string, number> };
      expect(options.projection).toEqual({ _id: 0, slug: 1 });
    });

    it("keeps the answer when the place lookup fails, and retries later", async () => {
      let attempts = 0;
      const failing: Coll = {
        ...new FakeColl(),
        findMany: async () => {
          attempts++;
          throw Object.assign(new Error("not authorized on places"), {
            name: "MongoServerError",
          });
        },
      } as unknown as Coll;
      const { history, call, tick } = setup([], failing);
      history.docs.push(
        hist("nairobi-ke", "2026-10-18", "1"),
        hist("nairobi-518dd4", "2026-10-31", "2"),
      );
      const ask = () => call("GET", "/history", undefined, nairobiQuery);
      const first = await ask();
      expect(first.status).toBe(200);
      expect(
        (first.body as { days: { locationSlug: string }[] }).days.map(
          (d) => d.locationSlug,
        ),
      ).toEqual(["nairobi-ke"]);
      // Not hammered: the failure is remembered for a few minutes.
      await ask();
      expect(attempts).toBe(1);
      tick(301_000);
      await ask();
      expect(attempts).toBe(2);
    });

    it("remembers a good answer for an hour", async () => {
      const { places, call, tick } = setup(records);
      await call("GET", "/history", undefined, nairobiQuery);
      await call("GET", "/history", undefined, nairobiQuery);
      expect(places.calls).toHaveLength(1);
      tick(3_600_001);
      await call("GET", "/history", undefined, nairobiQuery);
      expect(places.calls).toHaveLength(2);
    });

    it("asks no place lookup unless aliases are wanted", async () => {
      const { places, call } = setup(records);
      await call(
        "GET",
        "/history",
        undefined,
        "slug=nairobi-ke&start=2026-10-01&end=2026-10-31",
      );
      expect(places.calls).toHaveLength(0);
    });

    it("needs the place's own coordinates, and one plain slug", async () => {
      const { call } = setup(records);
      const status = async (q: string) =>
        (await call("GET", "/history", undefined, q)).status;
      const range = "&start=2026-10-01&end=2026-10-31";
      expect(
        await status(`slug=harare&aliases=1&lat=-17.8&lon=31.0${range}`),
      ).toBe(200);
      expect(await status(`slug=harare&aliases=1${range}`)).toBe(400);
      expect(await status(`slug=harare&aliases=1&lat=-17.8${range}`)).toBe(400);
      expect(
        await status(`slug=harare&aliases=1&lat=91&lon=31.0${range}`),
      ).toBe(400);
      expect(
        await status(`slug=harare&aliases=1&lat=abc&lon=31.0${range}`),
      ).toBe(400);
      expect(await status(`slug=harare&aliases=1&lat=&lon=31.0${range}`)).toBe(
        400,
      );
      expect(
        await status(
          `slug=harare&slug=nairobi-ke&aliases=1&lat=1&lon=1${range}`,
        ),
      ).toBe(400);
      expect(
        await status(`slug=geo:gcpvj0e&aliases=1&lat=1&lon=1${range}`),
      ).toBe(400);
      expect(
        await status(`slug=cell:-17.85_31.05&aliases=1&lat=1&lon=1${range}`),
      ).toBe(400);
      // Anything but 1 is not an alias read, and coordinates are not needed.
      expect(await status(`slug=harare&aliases=yes${range}`)).toBe(200);
    });
  });

  describe("alias rules", () => {
    it("derives the names a catalogue slug can be an alias of", () => {
      expect(aliasBases("harare")).toEqual(["harare"]);
      expect(aliasBases("nairobi-ke")).toEqual(["nairobi-ke", "nairobi"]);
      expect(aliasBases("victoria-falls-zw")).toEqual([
        "victoria-falls-zw",
        "victoria-falls",
      ]);
      expect(aliasBases("ke")).toEqual(["ke"]);
    });

    it("accepts a base, a dash and six lowercase hex digits, nothing else", () => {
      const bases = ["nairobi-ke", "nairobi"];
      expect(isAliasOf("nairobi-518dd4", bases)).toBe(true);
      expect(isAliasOf("nairobi-ke-518dd4", bases)).toBe(true);
      expect(isAliasOf("nairobi-518DD4", bases)).toBe(false);
      expect(isAliasOf("nairobi-518dd", bases)).toBe(false);
      expect(isAliasOf("nairobi-518dd44", bases)).toBe(false);
      expect(isAliasOf("nairobi-west-518dd4", bases)).toBe(false);
      expect(isAliasOf("nairobi", bases)).toBe(false);
      expect(isAliasOf("nairobi-518dd4\n", bases)).toBe(false);
      expect(isAliasOf({ $ne: "x" }, bases)).toBe(false);
      expect(isAliasOf(undefined, bases)).toBe(false);
      expect(isAliasOf(`${"a".repeat(80)}-518dd4`, ["a".repeat(80)])).toBe(
        false,
      );
    });
  });

  it("builds its own filter from validated fields", async () => {
    const { history, call } = setup();
    await call(
      "GET",
      "/history",
      undefined,
      "slug=harare&slug=geo:gcpvj0e&start=2026-10-01&end=2026-10-31",
    );
    const q = history.calls.find((c) => c.op === "findMany")!;
    expect(q.filter).toEqual({
      locationSlug: { $in: ["harare", "geo:gcpvj0e"] },
      date: { $gte: "2026-10-01", $lte: "2026-10-31" },
    });
  });
});

describe("POST /history/days", () => {
  it("inserts archive days with a document the bridge builds itself", async () => {
    const { history, call } = setup();
    const r = await call("POST", "/history/days", {
      slug: "geo:gcpvj0e",
      days: [
        day("2026-10-28"),
        day("2026-10-27", { source: "open-meteo-archive" }),
      ],
    });
    expect(r).toEqual({ status: 200, body: { inserted: 2, existing: 0 } });
    expect(history.docs).toHaveLength(2);
    const d = history.docs.find((x) => x.date === "2026-10-28")!;
    expect(d).toMatchObject({
      locationSlug: "geo:gcpvj0e",
      source: "nasa-power",
      provider: "nasa-power",
      aggregation: "daily-mean",
      insights: { dewPoint: 8.6 },
    });
    expect(d.recordedAt).toEqual(NOW);
    expect(d.createdAt).toEqual(NOW);
  });

  it("is insert-only: a stored day is never overwritten, recorded or not", async () => {
    const { history, call } = setup();
    history.docs.push({
      _id: "r",
      locationSlug: "harare",
      date: "2026-10-28",
      source: "recorded",
      current: { temperature_2m: 99 },
    });
    const body = {
      slug: "harare",
      days: [day("2026-10-28"), day("2026-10-27")],
    };
    expect((await call("POST", "/history/days", body)).body).toEqual({
      inserted: 1,
      existing: 1,
    });
    expect(history.docs.find((x) => x.date === "2026-10-28")).toMatchObject({
      source: "recorded",
      current: { temperature_2m: 99 },
    });
    // The same batch again changes nothing.
    expect((await call("POST", "/history/days", body)).body).toEqual({
      inserted: 0,
      existing: 2,
    });
    expect(history.docs).toHaveLength(2);
  });

  it("refuses what it must not store", async () => {
    const { history, call } = setup();
    const post = async (body: unknown) =>
      (await call("POST", "/history/days", body)).status;
    const one = (over: Record<string, unknown>) => ({
      slug: "harare",
      days: [day("2026-10-28", over)],
    });
    expect(await post(undefined)).toBe(400);
    expect(await post({ slug: "harare", days: [] })).toBe(400);
    expect(await post({ slug: "Bad Slug", days: [day("2026-10-28")] })).toBe(
      400,
    );
    expect(await post({ slug: "harare", days: [day("2026-10-31")] })).toBe(400); // today
    expect(await post({ slug: "harare", days: [day("2027-01-01")] })).toBe(400); // future
    expect(await post({ slug: "harare", days: [day("1939-01-01")] })).toBe(400);
    expect(await post({ slug: "harare", days: [day("2026-02-30")] })).toBe(400);
    expect(await post(one({ source: "recorded" }))).toBe(400); // never forge a recorded day
    expect(await post(one({ source: "other" }))).toBe(400);
    expect(
      await post({
        slug: "harare",
        days: [day("2026-10-28"), day("2026-10-28")],
      }),
    ).toBe(400);
    expect(await post(one({ current: { evil: 1 } }))).toBe(400);
    expect(await post(one({ current: { temperature_2m: "hot" } }))).toBe(400);
    expect(
      await post(
        one({ current: { temperature_2m: Number.POSITIVE_INFINITY } }),
      ),
    ).toBe(400);
    expect(await post(one({ daily: { time: ["2026-10-27"] } }))).toBe(400);
    expect(
      await post(
        one({ daily: { time: ["2026-10-28"], temperature_2m_max: [1, 2] } }),
      ),
    ).toBe(400);
    expect(
      await post(one({ daily: { time: ["2026-10-28"], hacked: [1] } })),
    ).toBe(400);
    expect(
      await post(
        one({ daily: { time: ["2026-10-28"], sunrise: ["morning"] } }),
      ),
    ).toBe(400);
    expect(await post(one({ insights: { dewPoint: "x" } }))).toBe(400);
    expect(await post(one({ insights: { other: 1 } }))).toBe(400);
    expect(history.docs).toHaveLength(0);
  });

  it("drops fields it was not given and ignores a caller's own recordedAt", async () => {
    const { history, call } = setup();
    const sneaky = {
      ...day("2026-10-28"),
      recordedAt: "1999-01-01",
      _id: "x",
      locationSlug: "other",
    };
    const r = await call("POST", "/history/days", {
      slug: "harare",
      days: [sneaky],
    });
    expect(r.status).toBe(200);
    expect(history.docs[0]).toMatchObject({ locationSlug: "harare" });
    expect(history.docs[0]!.recordedAt).toEqual(NOW);
    expect(history.docs[0]!._id).not.toBe("x");
  });

  it("bounds a batch", () => {
    const days = Array.from({ length: 801 }, (_, i) =>
      day(`2020-01-${String((i % 28) + 1).padStart(2, "0")}`),
    );
    expect(
      validateHistoryWrite({ slug: "harare", days }, "2026-10-31").ok,
    ).toBe(false);
    expect(
      validateHistoryRead(
        new URLSearchParams("slug=harare&start=2026-10-01&end=2026-10-02"),
      ).ok,
    ).toBe(true);
  });

  it("only POST writes and only GET reads", async () => {
    const { call } = setup();
    expect((await call("GET", "/history/days")).status).toBe(405);
    expect((await call("POST", "/history")).status).toBe(405);
    expect((await call("DELETE", "/history")).status).toBe(405);
  });
});
