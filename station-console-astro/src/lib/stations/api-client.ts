import type {
  IssuedCredentials,
  ReadingInput,
  ReadingResult,
  RegisterInput,
  StationStatus,
  StationSummary,
  StationType,
} from "./types";

type Fetch = typeof fetch;

export class ConsoleApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ConsoleApiError";
    this.status = status;
  }
}

/** Browser-side wrapper for the same-origin BFF (`/api/stations/*`). */
export class ConsoleApi {
  constructor(private readonly fetchImpl: Fetch = (...a) => fetch(...a)) {}

  private async request<T>(path: string, init: RequestInit & { key?: string | undefined } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.body) headers["Content-Type"] = "application/json";
    if (init.key) headers["X-Station-Key"] = init.key;
    const { key: _key, ...rest } = init;
    const res = await this.fetchImpl(path, { ...rest, headers, credentials: "same-origin" });
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const message =
        typeof payload === "object" && payload !== null && "error" in payload
          ? String((payload as { error: unknown }).error)
          : `Request failed (${res.status})`;
      throw new ConsoleApiError(res.status, message);
    }
    return payload as T;
  }

  register(input: RegisterInput) {
    return this.request<IssuedCredentials & { stationType: StationType }>("/api/stations", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async list(): Promise<StationSummary[]> {
    return (await this.request<{ stations: StationSummary[] }>("/api/stations")).stations;
  }

  status(stationId: string, key?: string) {
    return this.request<StationStatus>(`/api/stations/${encodeURIComponent(stationId)}`, { key });
  }

  submitReading(stationId: string, reading: ReadingInput, key?: string) {
    return this.request<ReadingResult>(`/api/stations/${encodeURIComponent(stationId)}/readings`, {
      method: "POST",
      body: JSON.stringify(reading),
      key,
    });
  }

  rotateKey(stationId: string) {
    return this.request<IssuedCredentials>(`/api/stations/${encodeURIComponent(stationId)}/rotate-key`, {
      method: "POST",
    });
  }
}
