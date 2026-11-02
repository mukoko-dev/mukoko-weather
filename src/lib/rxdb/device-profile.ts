/**
 * The device preference profile on the Rust Worker (`/v1/devices`), as the
 * replication handlers use it.
 *
 * A device's profile does not exist on the Worker until something creates it
 * (`POST /v1/devices`). The app never did, so every `GET` and `PATCH
 * /v1/devices/{id}` answered 404, on every page load, from every device
 * (#414). The rules here:
 *
 * - A 404 on a device id creates the profile ONCE, with `POST /v1/devices`
 *   carrying the same `deviceId` (the Worker treats a caller-supplied id as
 *   idempotent and does not meter it) and the device's current preferences,
 *   so the new server profile starts equal to the device and a pull never
 *   overwrites local choices with defaults.
 * - If the profile is still missing right after a successful create, or the
 *   Worker refuses the create for good (a 4xx other than 429), the device
 *   stays local-only for the rest of the session: no second create, no retry
 *   loop on 404.
 * - A failure (network, 5xx, 429, a refused create) backs off exponentially
 *   (30 s doubling to 15 min); while it lasts nothing is sent, and a push asks
 *   RxDB to retry later so the change is not lost.
 * - Two requests that meet a 404 together share one create.
 *
 * Pure of RxDB and of the browser: the transport and the clock are injected so
 * the rules are tested with a fake Worker.
 */

import { workerUrl, type WorkerRoute } from "../weather-api";

export const DEVICE_SYNC_BACKOFF_BASE_MS = 30_000;
export const DEVICE_SYNC_BACKOFF_MAX_MS = 15 * 60_000;
/** Ceiling for one request to the Worker. */
const REQUEST_TIMEOUT_MS = 8_000;

/** UUID v4 format — validates deviceId before interpolating into URL paths. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateDeviceId(id: string): string {
  if (!UUID_RE.test(id)) {
    throw new Error(`Invalid device ID format: ${id.slice(0, 20)}`);
  }
  return id;
}

/** The preferences the Worker's profile carries (what a PATCH sends). */
export interface DevicePrefsBody {
  theme: string;
  selectedLocation: string;
  savedLocations: string[];
  locationLabels: Record<string, string>;
  selectedActivities: string[];
  hasOnboarded: boolean;
  selectedForecastModel: string;
}

/** What `GET /v1/devices/{id}` answers (only `preferences` is read). */
export interface ServerProfile {
  preferences?: Partial<DevicePrefsBody> | null;
  [key: string]: unknown;
}

export interface DeviceProfileClientOptions {
  deviceId: string;
  fetcher?: typeof fetch;
  now?: () => number;
  /** The device's current preferences, for the create (null: use defaults). */
  localPrefs?: () => Promise<DevicePrefsBody | null>;
}

export interface DeviceProfileClient {
  /**
   * Read the server profile. Never throws: `null` means nothing to apply
   * (missing and just created from this device, local-only, backing off,
   * offline or a refusal).
   */
  pull(): Promise<ServerProfile | null>;
  /**
   * Send the preferences. Resolves when they were delivered or rejected for
   * good (a 4xx other than 404/429 will not get better), when this device is
   * local-only for the session. Rejects when it should be tried again later.
   */
  push(prefs: DevicePrefsBody): Promise<void>;
  /** Back-off bookkeeping, for diagnostics and tests. */
  state(): { failures: number; blockedUntil: number; localOnly: boolean };
}

export function createDeviceProfileClient({
  deviceId,
  fetcher = (...args) => fetch(...args),
  now = Date.now,
  localPrefs = async () => null,
}: DeviceProfileClientOptions): DeviceProfileClient {
  validateDeviceId(deviceId);

  let failures = 0;
  let blockedUntil = 0;
  /** Created this session: a second 404 is not answered with a second create. */
  let created = false;
  /** Gave up for this session (the profile stays missing after a create). */
  let localOnly = false;
  let creating: Promise<boolean> | null = null;

  const blocked = () => now() < blockedUntil;

  function fail(): void {
    failures += 1;
    const wait = Math.min(
      DEVICE_SYNC_BACKOFF_MAX_MS,
      DEVICE_SYNC_BACKOFF_BASE_MS * 2 ** (failures - 1),
    );
    blockedUntil = now() + wait;
  }

  function succeed(): void {
    failures = 0;
    blockedUntil = 0;
  }

  /** One request; a rejected fetch is a failure (back-off) and a throw. */
  async function send(
    method: "GET" | "POST" | "PATCH",
    route: WorkerRoute,
    body?: unknown,
  ): Promise<Response> {
    try {
      return await fetcher(workerUrl(route, ""), {
        method,
        headers:
          body === undefined
            ? undefined
            : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      fail();
      throw err instanceof Error
        ? err
        : new Error("device sync request failed");
    }
  }

  /** Create the profile (once per session). True when it exists now. */
  function ensureProfile(prefs: DevicePrefsBody | null): Promise<boolean> {
    if (creating) return creating;
    if (created) {
      // The profile was created this session and is STILL missing: stop here.
      localOnly = true;
      return Promise.resolve(false);
    }
    creating = (async () => {
      try {
        const res = await send("POST", "devices", {
          deviceId,
          ...(prefs ? { preferences: prefs } : {}),
        });
        if (res.ok) {
          created = true;
          succeed();
          return true;
        }
        await res.body?.cancel().catch(() => undefined);
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          // The Worker refuses this profile for good (invalid preferences):
          // asking again cannot help, so stay local-only for the session
          // instead of retrying forever.
          localOnly = true;
          return false;
        }
        fail();
        return false;
      } catch {
        return false; // send() already recorded the failure
      } finally {
        creating = null;
      }
    })();
    return creating;
  }

  async function pull(): Promise<ServerProfile | null> {
    if (localOnly || blocked()) return null;
    let res: Response;
    try {
      res = await send("GET", `devices/${deviceId}`);
    } catch {
      return null;
    }
    if (res.ok) {
      succeed();
      try {
        const profile = (await res.json()) as ServerProfile;
        return profile?.preferences ? profile : null;
      } catch {
        return null;
      }
    }
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 404) {
      // Created from the device's own preferences, so there is nothing to
      // apply: the server now equals this device.
      await ensureProfile(await localPrefs().catch(() => null));
      return null;
    }
    if (res.status >= 500 || res.status === 429) fail();
    return null;
  }

  async function push(prefs: DevicePrefsBody): Promise<void> {
    if (localOnly) return;
    if (blocked()) throw new Error("Device sync backing off — will retry");
    const res = await send("PATCH", `devices/${deviceId}`, prefs);
    if (res.ok) {
      succeed();
      return;
    }
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 404) {
      // The create carries these preferences, so no second PATCH is needed.
      if (await ensureProfile(prefs)) return;
      if (localOnly) return;
      throw new Error("Device profile could not be created — will retry");
    }
    if (res.status >= 500 || res.status === 429) {
      fail();
      throw new Error(`Device sync ${res.status} — will retry`);
    }
    // Any other 4xx is our request being refused: retrying cannot help.
  }

  return {
    pull,
    push,
    state: () => ({ failures, blockedUntil, localOnly }),
  };
}
