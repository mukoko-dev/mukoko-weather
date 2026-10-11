import type { APIContext } from "astro";
import { callerFrom } from "../../auth/session";
import { runtime } from "../runtime-config";
import type { Caller, StationsClient } from "../stations/types";
import { type BffRequest, type BffResponse, unauthenticated } from "./handlers";

export function bffRequest(context: APIContext): BffRequest {
  const { request, url } = context;
  return {
    method: request.method,
    origin: url.origin,
    requestOrigin: request.headers.get("origin"),
    contentType: request.headers.get("content-type"),
    stationKey: request.headers.get("x-station-key"),
    json: () => request.json(),
  };
}

export function toResponse(r: BffResponse): Response {
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Resolves the session and client, or answers 401 JSON. */
export async function withCaller(
  context: APIContext,
  run: (client: StationsClient, caller: Caller) => Promise<BffResponse>,
): Promise<Response> {
  const caller = callerFrom(context.locals.auth);
  if (!caller) return toResponse(unauthenticated());
  return toResponse(await run(runtime().client, caller));
}
