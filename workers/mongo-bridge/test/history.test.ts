import { describe, expect, it } from "vitest";
import { route, type Deps, type Result } from "../src/handlers";
import { deviceStore, historyStore, reportStore } from "../src/stores";
import {
  validateHistoryRead,
  validateHistoryWrite,
  validHistoryKey,
} from "../src/validate";
import { FakeColl } from "./fake";

const NOW = new Date("2026-10-31T12:00:00.000Z");

function setup() {
  const history = new FakeColl();
  const deps: Deps = {
    stores: {
      devices: deviceStore(new FakeColl(["deviceId"])),
      reports: reportStore(new FakeColl()),
      history: historyStore(history),
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
  return { history, call };
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
