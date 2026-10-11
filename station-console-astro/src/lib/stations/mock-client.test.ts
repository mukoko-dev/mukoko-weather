import { beforeEach, describe, expect, it } from "vitest";
import { MOCK_LEGACY_STATION, MockStationsClient } from "./mock-client";
import { type Caller, StationsApiError } from "./types";

const alice: Caller = { personId: "p-alice", email: "alice@example.test" };
const bob: Caller = { personId: "p-bob", email: "bob@example.test" };
const input = {
  name: "Alice farm",
  lat: -17.8,
  lon: 31.05,
  stationType: "manual",
} as const;

let client: MockStationsClient;
beforeEach(() => {
  client = new MockStationsClient(() => new Date("2026-10-11T08:00:00Z"));
});

const status = (e: unknown) =>
  e instanceof StationsApiError ? e.status : null;

describe("MockStationsClient", () => {
  it("registers with a backend-shaped id and a fresh key each time", async () => {
    const a = await client.register(alice, input);
    const b = await client.register(alice, input);
    expect(a.stationId).toMatch(/^mws-[a-f0-9]{8}$/);
    expect(a.ingestKey.length).toBeGreaterThanOrEqual(30);
    expect(a.ingestKey).not.toBe(b.ingestKey);
    expect(a.stationType).toBe("manual");
  });

  it("lists only the caller's stations and never exposes a key", async () => {
    await client.register(alice, input);
    expect(await client.list(bob)).toEqual([]);
    const mine = await client.list(alice);
    expect(mine).toHaveLength(1);
    expect(JSON.stringify(mine)).not.toMatch(/key/i);
  });

  it("hides other owners' stations as not found", async () => {
    const { stationId } = await client.register(alice, input);
    await expect(client.status(bob, stationId)).rejects.toSatisfy(
      (e) => status(e) === 404,
    );
    await expect(
      client.submitReading(bob, stationId, { temperatureC: 20 }),
    ).rejects.toSatisfy((e) => status(e) === 404);
    await expect(client.status(bob, "mws-ffffffff")).rejects.toSatisfy(
      (e) => status(e) === 404,
    );
  });

  it("accepts a station key from a non-owner, and rejects a wrong one", async () => {
    const { stationId, ingestKey } = await client.register(alice, input);
    expect(
      (await client.status(bob, stationId, { stationKey: ingestKey }))
        .stationId,
    ).toBe(stationId);
    await expect(
      client.status(bob, stationId, { stationKey: "nope" }),
    ).rejects.toSatisfy((e) => status(e) === 404);
  });

  it("serves the seeded legacy station by key only", async () => {
    const s = MOCK_LEGACY_STATION;
    expect(await client.list(alice)).toEqual([]);
    expect(
      (await client.status(alice, s.stationId, { stationKey: s.key })).name,
    ).toBe(s.name);
    await expect(client.status(alice, s.stationId)).rejects.toSatisfy(
      (e) => status(e) === 404,
    );
  });

  it("validates a reading, records backend metric names and the time", async () => {
    const { stationId } = await client.register(alice, input);
    const res = await client.submitReading(alice, stationId, {
      temperatureC: 21.5,
      rainfallMm: 2,
    });
    expect(res).toEqual({ accepted: 2, qcStatus: "validated" });
    const st = await client.status(alice, stationId);
    expect(st.lastObservationAt).toBe("2026-10-11T08:00:00.000Z");
    expect(st.latestMetrics).toEqual({
      airTemperatureCelsius: 21.5,
      precipitationMillimeters: 2,
    });
  });

  it("rejects readings that fail quality control and leaves status untouched", async () => {
    const { stationId } = await client.register(alice, input);
    expect(
      await client.submitReading(alice, stationId, { temperatureC: 99 }),
    ).toEqual({ accepted: 0, qcStatus: "rejected" });
    expect(
      (await client.status(alice, stationId)).lastObservationAt,
    ).toBeNull();
  });

  it("rotates the key: new key works, old key stops, a key cannot rotate itself", async () => {
    const { stationId, ingestKey } = await client.register(alice, input);
    await expect(client.rotateKey(bob, stationId)).rejects.toSatisfy(
      (e) => status(e) === 404,
    );
    const rotated = await client.rotateKey(alice, stationId);
    expect(rotated.ingestKey).not.toBe(ingestKey);
    await expect(
      client.status(bob, stationId, { stationKey: ingestKey }),
    ).rejects.toSatisfy((e) => status(e) === 404);
    expect(
      (await client.status(bob, stationId, { stationKey: rotated.ingestKey }))
        .stationId,
    ).toBe(stationId);
    await expect(client.rotateKey(bob, stationId)).rejects.toBeInstanceOf(
      StationsApiError,
    );
  });
});
