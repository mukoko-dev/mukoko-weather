import {
  type Caller,
  type IssuedCredentials,
  type KeyAuth,
  type ReadingInput,
  type ReadingResult,
  type RegisterInput,
  type StationStatus,
  StationsApiError,
  type StationsClient,
  type StationSummary,
  type StationType,
} from "./types";

type Fetch = typeof fetch;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string")
    throw new StationsApiError(502, `Nyuchi API sent no ${field}`);
  return v;
}

function type(v: unknown): StationType {
  return v === "manual" ? "manual" : "digital";
}

function summary(v: unknown): StationSummary {
  if (!isRecord(v))
    throw new StationsApiError(502, "Nyuchi API sent an unreadable station");
  return {
    stationId: str(v.stationId, "stationId"),
    name: typeof v.name === "string" ? v.name : "",
    stationType: type(v.stationType),
    status: typeof v.status === "string" ? v.status : "unknown",
    lastObservationAt:
      typeof v.lastObservationAt === "string" ? v.lastObservationAt : null,
  };
}

function metrics(v: unknown): Record<string, number> | null {
  if (!isRecord(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) if (typeof n === "number") out[k] = n;
  return Object.keys(out).length ? out : null;
}

/**
 * StationsClient for the Nyuchi API (api-gateway), the only data egress of
 * this app. Paths and shapes follow the proposed `/v1/stations` contract
 * (mukoko-dev/mukoko-weather#293, section 5.3). The caller's WorkOS access
 * token is forwarded as a bearer credential; a station key, when the console
 * holds one for a legacy station, goes in `X-Station-Key`. Neither is logged.
 */
export class NyuchiStationsClient implements StationsClient {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  private async call(
    caller: Caller,
    path: string,
    init: { method?: string; body?: unknown; auth?: KeyAuth | undefined } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (caller.accessToken)
      headers.Authorization = `Bearer ${caller.accessToken}`;
    if (init.auth?.stationKey) headers["X-Station-Key"] = init.auth.stationKey;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? null : JSON.stringify(init.body),
        redirect: "manual",
      });
    } catch {
      throw new StationsApiError(502, "The station service is unreachable");
    }
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const detail =
        isRecord(payload) && typeof payload.detail === "string"
          ? payload.detail
          : null;
      // Map upstream auth failures to the caller's own 404/401 vocabulary.
      throw new StationsApiError(
        res.status >= 500 ? 502 : res.status,
        detail ?? `Request failed (${res.status})`,
      );
    }
    return payload;
  }

  async register(caller: Caller, input: RegisterInput) {
    const p = await this.call(caller, "/v1/stations", {
      method: "POST",
      body: input,
    });
    if (!isRecord(p))
      throw new StationsApiError(502, "Nyuchi API sent an unreadable answer");
    return {
      stationId: str(p.stationId, "stationId"),
      ingestKey: str(p.ingestKey, "ingestKey"),
      stationType: type(p.stationType ?? input.stationType),
    };
  }

  async list(caller: Caller): Promise<StationSummary[]> {
    const p = await this.call(caller, "/v1/stations");
    const items =
      isRecord(p) && Array.isArray(p.stations)
        ? p.stations
        : Array.isArray(p)
          ? p
          : null;
    if (!items)
      throw new StationsApiError(502, "Nyuchi API sent an unreadable list");
    return items.map(summary);
  }

  async status(
    caller: Caller,
    stationId: string,
    auth?: KeyAuth,
  ): Promise<StationStatus> {
    const p = await this.call(
      caller,
      `/v1/stations/${encodeURIComponent(stationId)}`,
      { auth },
    );
    return {
      ...summary(p),
      latestMetrics: isRecord(p) ? metrics(p.latestMetrics) : null,
    };
  }

  async submitReading(
    caller: Caller,
    stationId: string,
    reading: ReadingInput,
    auth?: KeyAuth,
  ): Promise<ReadingResult> {
    const p = await this.call(
      caller,
      `/v1/stations/${encodeURIComponent(stationId)}/readings`,
      {
        method: "POST",
        body: reading,
        auth,
      },
    );
    if (!isRecord(p))
      throw new StationsApiError(502, "Nyuchi API sent an unreadable answer");
    return {
      accepted: typeof p.accepted === "number" ? p.accepted : 0,
      qcStatus: p.qcStatus === "validated" ? "validated" : "rejected",
    };
  }

  async rotateKey(
    caller: Caller,
    stationId: string,
  ): Promise<IssuedCredentials> {
    const p = await this.call(
      caller,
      `/v1/stations/${encodeURIComponent(stationId)}/rotate-key`,
      {
        method: "POST",
      },
    );
    if (!isRecord(p))
      throw new StationsApiError(502, "Nyuchi API sent an unreadable answer");
    return { stationId, ingestKey: str(p.ingestKey, "ingestKey") };
  }
}
