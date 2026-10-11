import { describe, expect, it } from "vitest";
import { MockStationsClient } from "./stations/mock-client";
import { NyuchiStationsClient } from "./stations/nyuchi-client";
import { createStationsClient, DEFAULT_INGEST_HOST, resolveConfig } from "./config";

describe("resolveConfig", () => {
  it("defaults to the mock backend and the hardware ingest host", () => {
    expect(resolveConfig({})).toEqual({ backend: "mock", nyuchiApiUrl: null, ingestHost: DEFAULT_INGEST_HOST });
    expect(DEFAULT_INGEST_HOST).toBe("weather.mukoko.com");
  });
  it("requires a valid https URL for the nyuchi backend", () => {
    expect(() => resolveConfig({ STATIONS_BACKEND: "nyuchi" })).toThrow(/NYUCHI_API_URL/);
    expect(() => resolveConfig({ STATIONS_BACKEND: "nyuchi", NYUCHI_API_URL: "not a url" })).toThrow(/absolute/);
    expect(() => resolveConfig({ STATIONS_BACKEND: "nyuchi", NYUCHI_API_URL: "http://api.example.test" })).toThrow(/https/);
    expect(resolveConfig({ STATIONS_BACKEND: "nyuchi", NYUCHI_API_URL: "https://api.example.test/base/" }).nyuchiApiUrl).toBe("https://api.example.test/base");
    expect(resolveConfig({ STATIONS_BACKEND: "nyuchi", NYUCHI_API_URL: "http://localhost:8000" }).nyuchiApiUrl).toBe("http://localhost:8000");
  });
  it("rejects an unknown backend instead of silently mocking", () => {
    expect(() => resolveConfig({ STATIONS_BACKEND: "mongo" })).toThrow(/mock.*nyuchi/);
  });
  it("validates the ingest host", () => {
    expect(resolveConfig({ PUBLIC_STATIONS_INGEST_HOST: "ingest.example.test" }).ingestHost).toBe("ingest.example.test");
    expect(() => resolveConfig({ PUBLIC_STATIONS_INGEST_HOST: "evil.test/<script>" })).toThrow(/host/);
  });
});

describe("createStationsClient", () => {
  it("picks the client from config and shares one mock", () => {
    const a = createStationsClient(resolveConfig({}));
    expect(a).toBeInstanceOf(MockStationsClient);
    expect(createStationsClient(resolveConfig({}))).toBe(a);
    expect(createStationsClient(resolveConfig({ STATIONS_BACKEND: "nyuchi", NYUCHI_API_URL: "https://api.example.test" }))).toBeInstanceOf(NyuchiStationsClient);
  });
});
