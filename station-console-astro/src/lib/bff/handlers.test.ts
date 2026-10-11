import { describe, expect, it, vi } from "vitest";
import { MockStationsClient } from "../stations/mock-client";
import {
  type Caller,
  StationsApiError,
  type StationsClient,
} from "../stations/types";
import {
  type BffRequest,
  checkWrite,
  listStations,
  registerStation,
  rotateKey,
  stationStatus,
  submitReading,
  unauthenticated,
} from "./handlers";

const caller: Caller = { personId: "p1", email: "a@example.test" };
const req = (
  over: Partial<BffRequest> & { body?: unknown } = {},
): BffRequest => ({
  method: "POST",
  origin: "https://console.example.test",
  requestOrigin: "https://console.example.test",
  contentType: "application/json",
  stationKey: null,
  json: async () => over.body ?? {},
  ...over,
});
const valid = { name: "Farm", lat: -17, lon: 31, stationType: "digital" };

describe("checkWrite", () => {
  it("allows same-origin JSON and absent Origin (non-browser)", () => {
    expect(checkWrite(req())).toBeNull();
    expect(checkWrite(req({ requestOrigin: null }))).toBeNull();
  });
  it("blocks cross-origin and non-JSON writes", () => {
    expect(
      checkWrite(req({ requestOrigin: "https://evil.example" }))?.status,
    ).toBe(403);
    expect(checkWrite(req({ contentType: "text/plain" }))?.status).toBe(415);
    expect(checkWrite(req({ contentType: null }))?.status).toBe(415);
  });
});

describe("register", () => {
  it("returns 201 with the one-time key", async () => {
    const r = await registerStation(
      new MockStationsClient(),
      caller,
      req({ body: valid }),
    );
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      stationId: expect.stringMatching(/^mws-/),
      ingestKey: expect.any(String),
    });
  });
  it("400 on invalid input, never calling the client", async () => {
    const client = { register: vi.fn() } as unknown as StationsClient;
    const r = await registerStation(
      client,
      caller,
      req({ body: { ...valid, lat: 500 } }),
    );
    expect(r.status).toBe(400);
    expect(client.register).not.toHaveBeenCalled();
  });
  it("400 on a malformed JSON body and 403 cross-origin", async () => {
    const bad = await registerStation(
      new MockStationsClient(),
      caller,
      req({
        json: async () => {
          throw new SyntaxError("x");
        },
      }),
    );
    expect(bad.status).toBe(400);
    const cross = await registerStation(
      new MockStationsClient(),
      caller,
      req({ requestOrigin: "https://evil.example", body: valid }),
    );
    expect(cross.status).toBe(403);
  });
});

describe("list / status / readings / rotate", () => {
  it("lists the caller's stations", async () => {
    const client = new MockStationsClient();
    await client.register(caller, {
      name: "F",
      lat: 0,
      lon: 0,
      stationType: "digital",
    });
    const r = await listStations(client, caller);
    expect((r.body as { stations: unknown[] }).stations).toHaveLength(1);
  });

  it("rejects malformed station ids before any lookup", async () => {
    const client = {
      status: vi.fn(),
      submitReading: vi.fn(),
      rotateKey: vi.fn(),
    } as unknown as StationsClient;
    expect(
      (await stationStatus(client, caller, "../etc", req({ method: "GET" })))
        .status,
    ).toBe(400);
    expect(
      (
        await submitReading(
          client,
          caller,
          "nope",
          req({ body: { windKph: 1 } }),
        )
      ).status,
    ).toBe(400);
    expect((await rotateKey(client, caller, "nope", req())).status).toBe(400);
    expect(client.status).not.toHaveBeenCalled();
  });

  it("passes the station key header through and validates readings", async () => {
    const client = new MockStationsClient();
    const { stationId, ingestKey } = await client.register(
      { personId: "owner", email: "" },
      { name: "F", lat: 0, lon: 0, stationType: "manual" },
    );
    const viaKey = await stationStatus(
      client,
      caller,
      stationId,
      req({ method: "GET", stationKey: ingestKey }),
    );
    expect(viaKey.status).toBe(200);
    expect(
      (await stationStatus(client, caller, stationId, req({ method: "GET" })))
        .status,
    ).toBe(404);
    const ok = await submitReading(
      client,
      caller,
      stationId,
      req({ stationKey: ingestKey, body: { temperatureC: 20 } }),
    );
    expect(ok).toEqual({
      status: 200,
      body: { accepted: 1, qcStatus: "validated" },
    });
    expect(
      (
        await submitReading(
          client,
          caller,
          stationId,
          req({ stationKey: ingestKey, body: {} }),
        )
      ).status,
    ).toBe(400);
  });

  it("maps StationsApiError to its status and hides unexpected errors", async () => {
    const boom = {
      list: async () => {
        throw new Error("mongodb://user:pw@host/db failed");
      },
    } as unknown as StationsClient;
    const r = await listStations(boom, caller);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/mongodb|pw@/);
    const teapot = {
      list: async () => {
        throw new StationsApiError(429, "Slow down");
      },
    } as unknown as StationsClient;
    expect(await listStations(teapot, caller)).toEqual({
      status: 429,
      body: { error: "Slow down" },
    });
  });
});

describe("unauthenticated", () => {
  it("is a 401 JSON error", () => {
    expect(unauthenticated().status).toBe(401);
  });
});
