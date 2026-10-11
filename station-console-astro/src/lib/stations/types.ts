/**
 * The console's view of a station. A station is a device (device.devices,
 * category weather_station) held by the Nyuchi API; these types are the BFF
 * contract the browser sees, independent of which client serves them.
 */

export type StationType = "digital" | "manual";

export interface RegisterInput {
  name: string;
  lat: number;
  lon: number;
  stationType: StationType;
  hardware?: string;
}

/** Returned once, at registration or key rotation. */
export interface IssuedCredentials {
  stationId: string;
  ingestKey: string;
}

export interface RegisteredStation extends IssuedCredentials {
  name: string;
  stationType: StationType;
}

/** A station as listed for its owner: never carries the key. */
export interface StationSummary {
  stationId: string;
  name: string;
  stationType: StationType;
  status: string;
  lastObservationAt: string | null;
}

export interface StationStatus extends StationSummary {
  latestMetrics: Record<string, number> | null;
}

export const READING_FIELDS = [
  "temperatureC",
  "rainfallMm",
  "humidityPercent",
  "pressureHpa",
  "windKph",
] as const;

export type ReadingField = (typeof READING_FIELDS)[number];
export type ReadingInput = Partial<Record<ReadingField, number>>;

export interface ReadingResult {
  accepted: number;
  qcStatus: "validated" | "rejected";
}

/** Who is calling the BFF: always derived from the server-side session. */
export interface Caller {
  personId: string;
  email: string;
  /** WorkOS access token; forwarded to the Nyuchi API, never to the browser. */
  accessToken?: string | undefined;
}

/** Set when a legacy (key-only) station is addressed without an owner. */
export interface KeyAuth {
  stationKey?: string | undefined;
}

export class StationsApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "StationsApiError";
    this.status = status;
  }
}

export interface StationsClient {
  register(caller: Caller, input: RegisterInput): Promise<IssuedCredentials & { stationType: StationType }>;
  list(caller: Caller): Promise<StationSummary[]>;
  status(caller: Caller, stationId: string, auth?: KeyAuth): Promise<StationStatus>;
  submitReading(
    caller: Caller,
    stationId: string,
    reading: ReadingInput,
    auth?: KeyAuth,
  ): Promise<ReadingResult>;
  rotateKey(caller: Caller, stationId: string): Promise<IssuedCredentials>;
}
