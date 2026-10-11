import { NYUCHI_API_URL, STATIONS_BACKEND } from "astro:env/server";
import { PUBLIC_STATIONS_INGEST_HOST } from "astro:env/client";
import { createStationsClient, resolveConfig } from "./config";

/** Reads the typed environment once per request and picks the client. */
export function runtime() {
  const config = resolveConfig({
    STATIONS_BACKEND,
    NYUCHI_API_URL,
    PUBLIC_STATIONS_INGEST_HOST,
  });
  return { config, client: createStationsClient(config) };
}
