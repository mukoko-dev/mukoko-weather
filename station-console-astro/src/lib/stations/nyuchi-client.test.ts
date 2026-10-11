import { describe, expect, it, vi } from "vitest";
import { NyuchiStationsClient } from "./nyuchi-client";
import { type Caller, StationsApiError } from "./types";

const caller: Caller = { personId: "p1", email: "a@example.test", accessToken: "tok-123" };

function client(reply: { status?: number; body?: unknown } | Error) {
  const fetchMock = vi.fn(async () => {
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  });
  return { fetchMock, api: new NyuchiStationsClient("https://api.example.test/", fetchMock as unknown as typeof fetch) };
}

const lastCall = (m: ReturnType<typeof vi.fn>) => {
  const [url, init] = m.mock.calls.at(-1) as unknown as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
};

describe("NyuchiStationsClient", () => {
  it("registers via POST /v1/stations with the bearer token and no manual redirect following", async () => {
    const { api, fetchMock } = client({ status: 201, body: { stationId: "mws-0a0a0a0a", ingestKey: "k", stationType: "manual" } });
    const r = await api.register(caller, { name: "Farm", lat: 1, lon: 2, stationType: "manual" });
    expect(r).toEqual({ stationId: "mws-0a0a0a0a", ingestKey: "k", stationType: "manual" });
    const { url, init, headers } = lastCall(fetchMock);
    expect(url).toBe("https://api.example.test/v1/stations");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(headers.Authorization).toBe("Bearer tok-123");
    expect(JSON.parse(init.body as string)).toMatchObject({ name: "Farm" });
  });

  it("forwards a station key header and URL-encodes the id", async () => {
    const { api, fetchMock } = client({ body: { stationId: "mws-0a0a0a0a", name: "F", stationType: "digital", status: "active", latestMetrics: { airTemperatureCelsius: 20, bad: "x" } } });
    const s = await api.status(caller, "mws-0a0a0a0a", { stationKey: "secret-key" });
    expect(s.latestMetrics).toEqual({ airTemperatureCelsius: 20 });
    const { url, headers } = lastCall(fetchMock);
    expect(url).toBe("https://api.example.test/v1/stations/mws-0a0a0a0a");
    expect(headers["X-Station-Key"]).toBe("secret-key");
    expect(url).not.toContain("secret-key");
  });

  it("lists from either {stations: []} or a bare array", async () => {
    const row = { stationId: "mws-0a0a0a0a", name: "F", stationType: "digital", status: "active", lastObservationAt: null };
    expect(await client({ body: { stations: [row] } }).api.list(caller)).toHaveLength(1);
    expect(await client({ body: [row] }).api.list(caller)).toHaveLength(1);
    await expect(client({ body: { nope: 1 } }).api.list(caller)).rejects.toMatchObject({ status: 502 });
  });

  it("posts readings and rotates keys on the contract paths", async () => {
    const a = client({ body: { accepted: 1, qcStatus: "validated" } });
    expect(await a.api.submitReading(caller, "mws-0a0a0a0a", { windKph: 3 })).toEqual({ accepted: 1, qcStatus: "validated" });
    expect(lastCall(a.fetchMock).url).toMatch(/\/v1\/stations\/mws-0a0a0a0a\/readings$/);
    const b = client({ body: { ingestKey: "new" } });
    expect(await b.api.rotateKey(caller, "mws-0a0a0a0a")).toEqual({ stationId: "mws-0a0a0a0a", ingestKey: "new" });
    expect(lastCall(b.fetchMock).url).toMatch(/\/rotate-key$/);
  });

  it("keeps client errors, hides upstream 5xx as 502 and network failures as 502", async () => {
    await expect(client({ status: 404, body: { detail: "Station not found" } }).api.status(caller, "mws-0a0a0a0a")).rejects.toMatchObject({ status: 404, message: "Station not found" });
    await expect(client({ status: 500, body: { detail: "mongo exploded at host x" } }).api.list(caller)).rejects.toMatchObject({ status: 502 });
    const e = await client(new Error("connect ECONNREFUSED 10.0.0.1")).api.list(caller).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StationsApiError);
    expect((e as StationsApiError).status).toBe(502);
    expect((e as StationsApiError).message).not.toContain("10.0.0.1");
  });

  it("rejects an answer without the one-time key", async () => {
    await expect(client({ body: { stationId: "mws-0a0a0a0a" } }).api.register(caller, { name: "F", lat: 0, lon: 0, stationType: "digital" })).rejects.toMatchObject({ status: 502 });
  });
});
