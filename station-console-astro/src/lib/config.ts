import type { StationsClient } from "./stations/types";
import { MockStationsClient } from "./stations/mock-client";
import { NyuchiStationsClient } from "./stations/nyuchi-client";

export interface ConsoleConfig {
  backend: "mock" | "nyuchi";
  nyuchiApiUrl: string | null;
  ingestHost: string;
}

export const DEFAULT_INGEST_HOST = "weather.mukoko.com";
export const INGEST_PATH = "/api/py/stations/ingest";

const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/i;

export interface RawConfig {
  STATIONS_BACKEND?: string | undefined;
  NYUCHI_API_URL?: string | undefined;
  PUBLIC_STATIONS_INGEST_HOST?: string | undefined;
}

/** Validates the environment; a bad value fails loudly rather than silently mocking. */
export function resolveConfig(raw: RawConfig): ConsoleConfig {
  const backend = raw.STATIONS_BACKEND === "nyuchi" ? "nyuchi" : "mock";
  if (raw.STATIONS_BACKEND && raw.STATIONS_BACKEND !== "mock" && raw.STATIONS_BACKEND !== "nyuchi")
    throw new Error(`STATIONS_BACKEND must be "mock" or "nyuchi", got "${raw.STATIONS_BACKEND}"`);

  let nyuchiApiUrl: string | null = null;
  if (backend === "nyuchi") {
    const url = raw.NYUCHI_API_URL?.trim();
    if (!url) throw new Error("NYUCHI_API_URL is required when STATIONS_BACKEND=nyuchi");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("NYUCHI_API_URL must be an absolute URL");
    }
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost")
      throw new Error("NYUCHI_API_URL must use https");
    nyuchiApiUrl = parsed.origin + parsed.pathname.replace(/\/+$/, "");
  }

  const host = raw.PUBLIC_STATIONS_INGEST_HOST?.trim() || DEFAULT_INGEST_HOST;
  if (!HOST_RE.test(host)) throw new Error("PUBLIC_STATIONS_INGEST_HOST must be a host name");

  return { backend, nyuchiApiUrl, ingestHost: host };
}

let mockSingleton: MockStationsClient | null = null;

/** The one place that picks a client. The mock is shared so state survives requests. */
export function createStationsClient(config: ConsoleConfig, fetchImpl: typeof fetch = fetch): StationsClient {
  if (config.backend === "nyuchi" && config.nyuchiApiUrl)
    return new NyuchiStationsClient(config.nyuchiApiUrl, fetchImpl);
  mockSingleton ??= new MockStationsClient();
  return mockSingleton;
}
