import {
  type Caller,
  type KeyAuth,
  StationsApiError,
  type StationsClient,
} from "../stations/types";
import {
  isStationId,
  parseReadingInput,
  parseRegisterInput,
} from "../stations/validators";

export interface BffRequest {
  method: string;
  origin: string;
  /** The `Origin` request header, when present. */
  requestOrigin: string | null;
  contentType: string | null;
  stationKey: string | null;
  /** Parsed lazily so malformed bodies become 400s, not exceptions. */
  json: () => Promise<unknown>;
}

export interface BffResponse {
  status: number;
  body: unknown;
}

const fail = (status: number, error: string): BffResponse => ({
  status,
  body: { error },
});

function keyAuth(req: BffRequest): KeyAuth | undefined {
  return req.stationKey ? { stationKey: req.stationKey } : undefined;
}

/** Same-origin only: browsers send Origin on cross-site POSTs. */
export function checkWrite(req: BffRequest): BffResponse | null {
  if (req.requestOrigin !== null && req.requestOrigin !== req.origin)
    return fail(403, "Cross-origin requests are not allowed");
  if (!req.contentType?.toLowerCase().startsWith("application/json"))
    return fail(415, "Send application/json");
  return null;
}

async function guarded(run: () => Promise<BffResponse>): Promise<BffResponse> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof StationsApiError) return fail(err.status, err.message);
    // Deliberately no detail: error objects can echo upstream URLs or keys.
    return fail(500, "Something went wrong. Try again.");
  }
}

export function unauthenticated(): BffResponse {
  return fail(401, "Sign in to use the station console");
}

export function registerStation(
  client: StationsClient,
  caller: Caller,
  req: BffRequest,
) {
  return guarded(async () => {
    const blocked = checkWrite(req);
    if (blocked) return blocked;
    const parsed = parseRegisterInput(await req.json().catch(() => null));
    if (!parsed.ok) return fail(400, parsed.error);
    return { status: 201, body: await client.register(caller, parsed.value) };
  });
}

export function listStations(client: StationsClient, caller: Caller) {
  return guarded(async () => ({
    status: 200,
    body: { stations: await client.list(caller) },
  }));
}

export function stationStatus(
  client: StationsClient,
  caller: Caller,
  id: string,
  req: BffRequest,
) {
  return guarded(async () => {
    if (!isStationId(id)) return fail(400, "Invalid station id");
    return { status: 200, body: await client.status(caller, id, keyAuth(req)) };
  });
}

export function submitReading(
  client: StationsClient,
  caller: Caller,
  id: string,
  req: BffRequest,
) {
  return guarded(async () => {
    const blocked = checkWrite(req);
    if (blocked) return blocked;
    if (!isStationId(id)) return fail(400, "Invalid station id");
    const parsed = parseReadingInput(await req.json().catch(() => null));
    if (!parsed.ok) return fail(400, parsed.error);
    return {
      status: 200,
      body: await client.submitReading(caller, id, parsed.value, keyAuth(req)),
    };
  });
}

export function rotateKey(
  client: StationsClient,
  caller: Caller,
  id: string,
  req: BffRequest,
) {
  return guarded(async () => {
    // Rotation needs no body, but still must be a same-origin write.
    if (req.requestOrigin !== null && req.requestOrigin !== req.origin)
      return fail(403, "Cross-origin requests are not allowed");
    if (!isStationId(id)) return fail(400, "Invalid station id");
    return { status: 200, body: await client.rotateKey(caller, id) };
  });
}
