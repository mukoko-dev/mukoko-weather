import { describe, expect, it } from "vitest";
import { route, needsStores, type Deps, type Result } from "../src/handlers";
import {
  deviceStore,
  historyStore,
  placeAliasStore,
  reportStore,
} from "../src/stores";
import { FakeColl } from "./fake";

const NOW = new Date("2026-10-19T10:00:00.000Z");

function setup(now: Date = NOW) {
  const devices = new FakeColl(["deviceId"]);
  const reports = new FakeColl();
  const history = new FakeColl();
  const deps: Deps = {
    stores: {
      devices: deviceStore(devices),
      reports: reportStore(reports),
      history: historyStore(history),
      places: placeAliasStore(new FakeColl()),
    },
    now: () => now,
    randomId: () => "generated-id",
  };
  const call = (
    method: string,
    path: string,
    body?: unknown,
    query = "",
  ): Promise<Result> =>
    route({ method, path, query: new URLSearchParams(query), body }, deps);
  return { devices, reports, history, deps, call };
}

const goodReport = {
  locationSlug: "harare",
  locationName: "Harare",
  lat: -17.8,
  lon: 31.05,
  reportType: "heavy-rain",
  severity: "severe",
  description: "flooding on the road",
  weatherSnapshot: {
    temperature: 19,
    weatherCode: 63,
    precipitation: 2,
    windSpeed: 12,
    humidity: 90,
  },
  reportedBy: "0123456789abcdef",
  verified: true,
};

describe("routing", () => {
  it("only database routes need the stores", () => {
    expect(needsStores("/devices")).toBe(true);
    expect(needsStores("/devices/x")).toBe(true);
    expect(needsStores("/reports")).toBe(true);
    expect(needsStores("/reports/upvote")).toBe(true);
    expect(needsStores("/history")).toBe(true);
    expect(needsStores("/history/days")).toBe(true);
    expect(needsStores("/health")).toBe(false);
    expect(needsStores("/admin")).toBe(false);
  });
  it("404 and 405", async () => {
    const { call } = setup();
    expect((await call("GET", "/nope")).status).toBe(404);
    expect((await call("GET", "/devices")).status).toBe(405);
    expect((await call("DELETE", "/devices/abc")).status).toBe(405);
    expect((await call("PUT", "/reports")).status).toBe(405);
    expect((await call("GET", "/reports/upvote")).status).toBe(405);
    expect((await call("GET", "/devices/a/b")).status).toBe(404);
  });
});

describe("devices", () => {
  it("creates a profile in the existing Mongo shape", async () => {
    const { call, devices } = setup();
    const r = await call("POST", "/devices", {
      deviceId: "dev-1",
      preferences: { theme: "dark" },
    });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      deviceId: "dev-1",
      preferences: {
        theme: "dark",
        selectedLocation: "",
        savedLocations: [],
        selectedActivities: [],
        hasOnboarded: false,
        selectedForecastModel: "best_match",
      },
      createdAt: "2026-10-19T10:00:00.000Z",
      updatedAt: "2026-10-19T10:00:00.000Z",
    });
    const stored = devices.docs[0]!;
    expect(Object.keys(stored).sort()).toEqual([
      "_id",
      "createdAt",
      "deviceId",
      "preferences",
      "updatedAt",
    ]);
    expect(stored.createdAt).toBeInstanceOf(Date);
    expect(Object.keys(stored.preferences as object).sort()).toEqual([
      "hasOnboarded",
      "savedLocations",
      "selectedActivities",
      "selectedForecastModel",
      "selectedLocation",
      "theme",
    ]);
  });
  it("generates an id when none is given", async () => {
    const { call } = setup();
    const r = await call("POST", "/devices", {});
    expect(r).toMatchObject({
      status: 201,
      body: { deviceId: "generated-id" },
    });
  });
  it("creating an existing id is idempotent and does not overwrite", async () => {
    const { call, devices } = setup();
    await call("POST", "/devices", {
      deviceId: "dev-1",
      preferences: { theme: "dark" },
    });
    const again = await call("POST", "/devices", {
      deviceId: "dev-1",
      preferences: { theme: "light" },
    });
    expect(again.status).toBe(201);
    expect(
      (again.body as { preferences: { theme: string } }).preferences.theme,
    ).toBe("dark");
    expect(devices.docs).toHaveLength(1);
  });
  it("a lost create race (duplicate key) returns the winner", async () => {
    const { deps, devices } = setup();
    const inner = devices.findOneAndUpdate.bind(devices);
    let first = true;
    devices.findOneAndUpdate = async (f, u, o) => {
      if (first && o.upsert) {
        first = false;
        devices.docs.push({
          _id: "w",
          deviceId: "dev-2",
          preferences: { theme: "dark" },
          createdAt: NOW,
          updatedAt: NOW,
        });
        throw Object.assign(new Error("dup"), { code: 11000 });
      }
      return inner(f, u, o);
    };
    const r = await route(
      {
        method: "POST",
        path: "/devices",
        query: new URLSearchParams(),
        body: { deviceId: "dev-2" },
      },
      deps,
    );
    expect(r).toMatchObject({
      status: 201,
      body: { deviceId: "dev-2", preferences: { theme: "dark" } },
    });
  });
  it("rejects a bad id, bad preferences and an unreadable body", async () => {
    const { call, devices } = setup();
    expect(
      (await call("POST", "/devices", { deviceId: "bad id" })).status,
    ).toBe(400);
    expect(
      (await call("POST", "/devices", { deviceId: { $ne: "" } })).status,
    ).toBe(400);
    const bad = await call("POST", "/devices", {
      preferences: { theme: "neon" },
    });
    expect(bad).toMatchObject({
      status: 400,
      body: {
        error: "invalid_request",
        error_description: "Invalid theme: neon",
      },
    });
    expect((await call("POST", "/devices", "text")).status).toBe(422);
    expect((await call("POST", "/devices", undefined)).status).toBe(422);
    expect(devices.docs).toHaveLength(0);
  });
  it("gets a profile, or 404", async () => {
    const { call } = setup();
    await call("POST", "/devices", { deviceId: "dev-1" });
    expect((await call("GET", "/devices/dev-1")).status).toBe(200);
    expect((await call("GET", "/devices/missing")).status).toBe(404);
    expect((await call("GET", "/devices/bad%20id")).status).toBe(404);
  });
  it("reads legacy documents with missing or odd fields as defaults", async () => {
    const { call, devices } = setup();
    devices.docs.push({
      _id: "1",
      deviceId: "old",
      preferences: { theme: "dark", savedLocations: ["a", 1] },
      createdAt: NOW,
    });
    const r = await call("GET", "/devices/old");
    expect(r.body).toMatchObject({
      preferences: {
        theme: "dark",
        savedLocations: ["a"],
        selectedLocation: "",
        selectedForecastModel: "best_match",
      },
      updatedAt: "1970-01-01T00:00:00.000Z",
    });
  });
  it("patches by dotted $set, last write wins, and stamps updatedAt", async () => {
    const later = new Date("2026-10-19T11:00:00.000Z");
    const s = setup();
    await s.call("POST", "/devices", {
      deviceId: "dev-1",
      preferences: { savedLocations: ["a", "b"] },
    });
    const p = setup(later);
    p.devices.docs = s.devices.docs;
    const r = await p.call("PATCH", "/devices/dev-1", {
      theme: "dark",
      savedLocations: ["c"],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      preferences: { theme: "dark", savedLocations: ["c"] },
      createdAt: "2026-10-19T10:00:00.000Z",
      updatedAt: "2026-10-19T11:00:00.000Z",
    });
    const call = p.devices.calls.find((c) => c.op === "findOneAndUpdate")!;
    expect(call.filter).toEqual({ deviceId: "dev-1" });
    expect(call.update).toEqual({
      $set: {
        "preferences.theme": "dark",
        "preferences.savedLocations": ["c"],
        updatedAt: later,
      },
    });
  });
  it("patch rejects empty, invalid and unknown devices", async () => {
    const { call } = setup();
    await call("POST", "/devices", { deviceId: "dev-1" });
    expect(await call("PATCH", "/devices/dev-1", {})).toMatchObject({
      status: 400,
      body: { error_description: "No fields to update" },
    });
    expect(
      (await call("PATCH", "/devices/dev-1", { selectedForecastModel: "x" }))
        .status,
    ).toBe(400);
    expect(
      (await call("PATCH", "/devices/ghost", { theme: "dark" })).status,
    ).toBe(404);
    expect((await call("PATCH", "/devices/dev-1", "x")).status).toBe(422);
  });
});

describe("reports", () => {
  it("submits a report in the existing Mongo shape with the severity's expiry", async () => {
    const { call, reports } = setup();
    const r = await call("POST", "/reports", goodReport);
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      id: "000000000000000000000001",
      verified: true,
      expiresIn: 259_200,
    });
    const doc = reports.docs[0]!;
    expect(Object.keys(doc).sort()).toEqual(
      [
        "_id",
        "description",
        "expiresAt",
        "lat",
        "locationName",
        "locationSlug",
        "lon",
        "reportType",
        "reportedAt",
        "reportedBy",
        "severity",
        "upvotedBy",
        "upvotes",
        "verified",
        "weatherSnapshot",
      ].sort(),
    );
    expect(doc.reportedAt).toEqual(NOW);
    expect(doc.expiresAt).toEqual(new Date(NOW.getTime() + 259_200_000));
    expect(doc.upvotes).toBe(0);
    expect(doc.upvotedBy).toEqual([]);
  });
  it("ignores caller-supplied times, votes and ids", async () => {
    const { call, reports } = setup();
    await call("POST", "/reports", {
      ...goodReport,
      severity: "mild",
      upvotes: 99,
      reportedAt: "x",
      expiresAt: "y",
      _id: "z",
      upvotedBy: ["a"],
    });
    const doc = reports.docs[0]!;
    expect(doc.upvotes).toBe(0);
    expect(doc.upvotedBy).toEqual([]);
    expect(doc.expiresAt).toEqual(new Date(NOW.getTime() + 86_400_000));
    expect(doc._id).not.toBe("z");
  });
  it("rejects invalid reports without writing", async () => {
    const { call, reports } = setup();
    expect(
      (await call("POST", "/reports", { ...goodReport, reportType: "x" }))
        .status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/reports", {
          ...goodReport,
          description: "x".repeat(301),
        })
      ).status,
    ).toBe(400);
    expect((await call("POST", "/reports", [])).status).toBe(422);
    expect(reports.docs).toHaveLength(0);
  });
  it("lists unexpired reports newest first, bounded, by key", async () => {
    const { call, reports, deps } = setup();
    const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
    const add = (slug: string, reportedAt: Date, expiresAt: Date, n: string) =>
      reports.docs.push({
        _id: n.padStart(24, "0"),
        locationSlug: slug,
        locationName: "X",
        reportType: "fog",
        severity: "mild",
        description: n,
        reportedAt,
        expiresAt,
        upvotes: 1,
        upvotedBy: ["secret"],
        verified: false,
        reportedBy: "secret",
      });
    const future = new Date(NOW.getTime() + 3_600_000);
    add("harare", at(5), future, "1");
    add("harare", at(1), future, "2");
    add("geo:ksy4dd7", at(2), future, "3");
    add("harare", at(3), at(0.5), "4"); // expired
    add("harare", at(30), future, "5"); // older than 24 h
    add("bulawayo", at(1), future, "6"); // other place
    const r = await call(
      "GET",
      "/reports",
      undefined,
      "slug=harare&slug=geo:ksy4dd7",
    );
    const ids = (r.body as { reports: { description: string }[] }).reports.map(
      (x) => x.description,
    );
    expect(ids).toEqual(["2", "3", "1"]);
    const first = (r.body as { reports: Record<string, unknown>[] })
      .reports[0]!;
    expect(Object.keys(first).sort()).toEqual([
      "description",
      "id",
      "locationName",
      "reportType",
      "reportedAt",
      "severity",
      "upvotes",
      "verified",
    ]);
    const wide = await call(
      "GET",
      "/reports",
      undefined,
      "slug=harare&hours=72",
    );
    expect((wide.body as { reports: unknown[] }).reports).toHaveLength(3);
    const q = reports.calls.filter((c) => c.op === "findMany").pop()!;
    expect((q.options as { limit: number }).limit).toBe(20);
    expect(deps).toBeTruthy();
  });
  it("never lists more than 20", async () => {
    const { call, reports } = setup();
    for (let i = 0; i < 30; i++) {
      reports.docs.push({
        _id: String(i).padStart(24, "0"),
        locationSlug: "harare",
        locationName: "H",
        reportType: "fog",
        severity: "mild",
        description: "",
        reportedAt: new Date(NOW.getTime() - i * 1000),
        expiresAt: new Date(NOW.getTime() + 1e6),
        upvotes: 0,
        verified: false,
      });
    }
    const r = await call(
      "GET",
      "/reports",
      undefined,
      "slug=harare&limit=1000",
    );
    expect((r.body as { reports: unknown[] }).reports).toHaveLength(20);
  });
  it("rejects bad list queries", async () => {
    const { call } = setup();
    expect((await call("GET", "/reports")).status).toBe(400);
    expect(
      (await call("GET", "/reports", undefined, "slug=%24where")).status,
    ).toBe(400);
  });
  it("upvotes once per voter, atomically", async () => {
    const { call, reports } = setup();
    const { body } = await call("POST", "/reports", goodReport);
    const reportId = (body as { id: string }).id;
    const vote = { reportId, voter: "aaaaaaaaaaaaaaaa" };
    expect((await call("POST", "/reports/upvote", vote)).body).toEqual({
      upvoted: true,
    });
    expect((await call("POST", "/reports/upvote", vote)).body).toEqual({
      upvoted: false,
      reason: "Already upvoted or report not found",
    });
    expect(
      (
        await call("POST", "/reports/upvote", {
          reportId,
          voter: "bbbbbbbbbbbbbbbb",
        })
      ).body,
    ).toEqual({ upvoted: true });
    const doc = reports.docs[0]!;
    expect(doc.upvotes).toBe(2);
    expect(doc.upvotedBy).toEqual(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]);
    const u = reports.calls.filter((c) => c.op === "updateOne")[0]!;
    expect(u.filter).toEqual({
      _id: reportId,
      upvotedBy: { $ne: "aaaaaaaaaaaaaaaa" },
    });
    expect(u.update).toEqual({
      $addToSet: { upvotedBy: "aaaaaaaaaaaaaaaa" },
      $inc: { upvotes: 1 },
    });
  });
  it("an unknown report is not upvoted, a malformed one is a 400", async () => {
    const { call } = setup();
    expect(
      (
        await call("POST", "/reports/upvote", {
          reportId: "f".repeat(24),
          voter: "a".repeat(16),
        })
      ).body,
    ).toMatchObject({ upvoted: false });
    expect(
      (
        await call("POST", "/reports/upvote", {
          reportId: "short",
          voter: "a".repeat(16),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/reports/upvote", {
          reportId: "f".repeat(24),
          voter: { $ne: 1 },
        })
      ).status,
    ).toBe(400);
    expect((await call("POST", "/reports/upvote", "x")).status).toBe(422);
  });
});
