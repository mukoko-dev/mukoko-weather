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

interface MockStation {
  stationId: string;
  name: string;
  stationType: StationType;
  ownerId: string | null;
  keyHash: string;
  status: string;
  lastObservationAt: string | null;
  latestMetrics: Record<string, number> | null;
}

/** Backend metric names for the console's reading fields. */
const METRIC_NAMES = {
  temperatureC: "airTemperatureCelsius",
  humidityPercent: "relativeHumidityPercent",
  pressureHpa: "atmosphericPressureMillibar",
  windKph: "windSpeedKph",
  rainfallMm: "precipitationMillimeters",
} as const;

/** Inline QC ranges of the backend (`QC_RANGES`), keyed by metric name. */
const QC_RANGES: Record<string, readonly [number, number]> = {
  airTemperatureCelsius: [-50, 60],
  relativeHumidityPercent: [0, 100],
  atmosphericPressureMillibar: [800, 1100],
  windSpeedKph: [0, 250],
  precipitationMillimeters: [0, 500],
};

/** Demo station for exercising the key-only (legacy) path against the mock. */
export const MOCK_LEGACY_STATION = {
  stationId: "mws-00000001",
  key: "legacy-demo-key",
  name: "Demo school (legacy key)",
} as const;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomStationId(): string {
  return `mws-${toHex(crypto.getRandomValues(new Uint8Array(4)))}`;
}

/**
 * In-memory StationsClient with the same behaviour the real API is specified
 * to have: owner-scoped lists, a key shown once, optional station-key access,
 * and the backend's quality-control ranges. State lives per instance.
 */
export class MockStationsClient implements StationsClient {
  private readonly stations = new Map<string, MockStation>();
  private seeded: Promise<void>;

  constructor(private readonly now: () => Date = () => new Date()) {
    this.seeded = this.seed();
  }

  private async seed(): Promise<void> {
    this.stations.set(MOCK_LEGACY_STATION.stationId, {
      stationId: MOCK_LEGACY_STATION.stationId,
      name: MOCK_LEGACY_STATION.name,
      stationType: "manual",
      ownerId: null,
      keyHash: await sha256(MOCK_LEGACY_STATION.key),
      status: "active",
      lastObservationAt: null,
      latestMetrics: null,
    });
  }

  private async authorise(caller: Caller, stationId: string, auth?: KeyAuth): Promise<MockStation> {
    await this.seeded;
    const station = this.stations.get(stationId);
    if (!station) throw new StationsApiError(404, "Station not found");
    if (station.ownerId !== null && station.ownerId === caller.personId) return station;
    if (auth?.stationKey && (await sha256(auth.stationKey)) === station.keyHash) return station;
    // Never reveal whether the id exists to someone who cannot use it.
    throw new StationsApiError(404, "Station not found");
  }

  async register(
    caller: Caller,
    input: RegisterInput,
  ): Promise<IssuedCredentials & { stationType: StationType }> {
    await this.seeded;
    const stationId = randomStationId();
    const ingestKey = randomKey();
    this.stations.set(stationId, {
      stationId,
      name: input.name,
      stationType: input.stationType,
      ownerId: caller.personId,
      keyHash: await sha256(ingestKey),
      status: "active",
      lastObservationAt: null,
      latestMetrics: null,
    });
    return { stationId, ingestKey, stationType: input.stationType };
  }

  async list(caller: Caller): Promise<StationSummary[]> {
    await this.seeded;
    return [...this.stations.values()]
      .filter((s) => s.ownerId === caller.personId)
      .map(({ stationId, name, stationType, status, lastObservationAt }) => ({
        stationId,
        name,
        stationType,
        status,
        lastObservationAt,
      }));
  }

  async status(caller: Caller, stationId: string, auth?: KeyAuth): Promise<StationStatus> {
    const s = await this.authorise(caller, stationId, auth);
    return {
      stationId: s.stationId,
      name: s.name,
      stationType: s.stationType,
      status: s.status,
      lastObservationAt: s.lastObservationAt,
      latestMetrics: s.latestMetrics,
    };
  }

  async submitReading(
    caller: Caller,
    stationId: string,
    reading: ReadingInput,
    auth?: KeyAuth,
  ): Promise<ReadingResult> {
    const s = await this.authorise(caller, stationId, auth);
    const metrics: Record<string, number> = {};
    for (const [field, value] of Object.entries(reading)) {
      const name = METRIC_NAMES[field as keyof typeof METRIC_NAMES];
      const range = name ? QC_RANGES[name] : undefined;
      if (name && range && typeof value === "number" && value >= range[0] && value <= range[1]) {
        metrics[name] = value;
      }
    }
    if (Object.keys(metrics).length === 0) return { accepted: 0, qcStatus: "rejected" };
    s.lastObservationAt = this.now().toISOString();
    s.latestMetrics = metrics;
    return { accepted: Object.keys(metrics).length, qcStatus: "validated" };
  }

  async rotateKey(caller: Caller, stationId: string): Promise<IssuedCredentials> {
    // Rotation is an owner action: a station key alone cannot rotate itself.
    const s = await this.authorise(caller, stationId);
    const ingestKey = randomKey();
    s.keyHash = await sha256(ingestKey);
    return { stationId, ingestKey };
  }
}
