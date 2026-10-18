/**
 * The platform's person-owned device record, as weather will use it.
 *
 * **Not live.** The Nyuchi API has no route that registers or lists a
 * person's own devices yet: `/v1/devices` is the household display model
 * (RFC 8628, owned by a `family` entity), and the permission, preference and
 * session fields below have no verified home in the `device.devices`
 * validator. The routes and fields in this file are the *proposal* filed as
 * platform asks in mukoko-dev/mukoko-weather#320, written against the same
 * transport interface as `gateway-app-keys.ts` so the switch is one constant.
 *
 * **No API key or shared secret anywhere in this path.** The only credential
 * is the signed-in person's own token (AuthKit access token, exchanged for a
 * person token), checked by the gateway against platform RBAC. On Vercel the
 * transport is `fetch` to `https://api.nyuchi.com`; a Worker would use a
 * Cloudflare service binding. Today's exchange still needs an internal key
 * (docs/AUTH.md); that is platform ask 5 in #320, not something built here.
 * Until then `PLATFORM_DEVICES_READY` is false, `/api/devices` registration
 * answers 503 `devices_unavailable`, and nothing is written anywhere.
 *
 * Weather never writes device data to MongoDB. It never sends a position,
 * an IP address or a user agent string: the registration carries a coarse
 * label, permission states, and preferences with place slugs coarsened.
 */

import {
  gatewayRequest,
  type GatewayTransport,
  parseRetryAfter,
} from "./nyuchi-gateway";
import type { DeviceBrowser, DeviceOs, DisplayMode } from "./device-info";
import {
  DISPLAY_MODE_VALUES,
  UA_CH_PLATFORMS,
  toPlatformRecord,
  type PermissionReport,
  type PermissionStateW3C,
  type StandardDevice,
  type UaChFormFactor,
} from "./device-standards";
import { coarsenSlug } from "./location-privacy";

/** The Nyuchi API. No key, no secret: the caller's own token is the credential. */
export const NYUCHI_API_ORIGIN = "https://api.nyuchi.com";

/** Flip only when the gateway serves the routes in asks 1 to 5 of #320. */
export const PLATFORM_DEVICES_READY = false;

const DEVICE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9-]{1,80}$/;
const ID_RE = /^[a-z0-9_-]{1,48}$/;
const PLATFORMS: ReadonlySet<string> = new Set(UA_CH_PLATFORMS);
const BROWSERS: ReadonlySet<string> = new Set([
  "Safari",
  "Chrome",
  "Firefox",
  "Edge",
  "Opera",
  "Samsung Internet",
  "Other",
]);
const FORM_FACTORS: ReadonlySet<string> = new Set([
  "Desktop",
  "Mobile",
  "Tablet",
]);
const DISPLAY_MODES: ReadonlySet<string> = new Set(DISPLAY_MODE_VALUES);
const PERMISSION_STATES: ReadonlySet<string> = new Set([
  "granted",
  "denied",
  "prompt",
]);
const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
const TIME_ZONE_RE = /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const THEMES: ReadonlySet<string> = new Set(["light", "dark", "system"]);
const MAX_ACTIVITIES = 30;
const MAX_SAVED = 10;

export type PermissionSnapshot = PermissionReport;

export interface DeviceRegistration extends StandardDevice {
  /** Keyed by W3C Permissions API name; absent = never decided or unsupported. */
  permissions: {
    geolocation: PermissionSnapshot | null;
    notifications: PermissionSnapshot | null;
  };
  preferences: {
    theme: string;
    selectedActivities: string[];
    /** Coarsened: a spot's geohash is cut to 4 characters. */
    savedLocations: string[];
    forecastModel: string;
    homeLocation: string | null;
  };
}

export class DevicesError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "DevicesError";
  }
}

function isoDate(v: unknown): string | null {
  if (typeof v !== "string" || !ISO_RE.test(v)) return null;
  return Number.isNaN(Date.parse(v)) ? null : v;
}

function snapshot(value: unknown): PermissionSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const { state, changedAt, promptDismissedAt } = value as Record<
    string,
    unknown
  >;
  if (typeof state !== "string" || !PERMISSION_STATES.has(state)) return null;
  const at = isoDate(changedAt);
  if (!at) return null;
  const dismissed = isoDate(promptDismissedAt);
  return {
    state: state as PermissionStateW3C,
    changedAt: at,
    ...(dismissed && state === "prompt"
      ? { promptDismissedAt: dismissed }
      : {}),
  };
}

function slugList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string" && SLUG_RE.test(v))
    .slice(0, max)
    .map(coarsenSlug);
}

/**
 * The registration, built only from allowlisted, validated fields of an
 * untrusted body. Anything else in the body is dropped; a body without a
 * valid device id is refused (null).
 */
export function sanitizeRegistration(raw: unknown): DeviceRegistration | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.deviceId !== "string" || !DEVICE_ID_RE.test(b.deviceId)) {
    return null;
  }
  const name =
    typeof b.name === "string"
      ? Array.from(b.name)
          .filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)
          .join("")
          .trim()
          .slice(0, 60)
      : "";
  const perms = (b.permissions ?? {}) as Record<string, unknown>;
  const prefs = (b.preferences ?? {}) as Record<string, unknown>;
  const home =
    typeof prefs.homeLocation === "string" && SLUG_RE.test(prefs.homeLocation)
      ? coarsenSlug(prefs.homeLocation)
      : null;
  return {
    deviceId: b.deviceId.toLowerCase(),
    name: name || "This device",
    platform: PLATFORMS.has(String(b.platform))
      ? (b.platform as DeviceOs)
      : "Unknown",
    browser: BROWSERS.has(String(b.browser))
      ? (b.browser as DeviceBrowser)
      : "Other",
    formFactor: FORM_FACTORS.has(String(b.formFactor))
      ? (b.formFactor as UaChFormFactor)
      : "Desktop",
    displayMode: DISPLAY_MODES.has(String(b.displayMode))
      ? (b.displayMode as DisplayMode)
      : "browser",
    locale:
      typeof b.locale === "string" && LOCALE_RE.test(b.locale)
        ? b.locale
        : "en",
    timeZone:
      typeof b.timeZone === "string" && TIME_ZONE_RE.test(b.timeZone)
        ? b.timeZone
        : "UTC",
    permissions: {
      geolocation: snapshot(perms.geolocation),
      notifications: snapshot(perms.notifications),
    },
    preferences: {
      theme: THEMES.has(String(prefs.theme)) ? String(prefs.theme) : "system",
      selectedActivities: Array.isArray(prefs.selectedActivities)
        ? prefs.selectedActivities
            .filter((v): v is string => typeof v === "string" && ID_RE.test(v))
            .slice(0, MAX_ACTIVITIES)
        : [],
      savedLocations: slugList(prefs.savedLocations, MAX_SAVED),
      forecastModel:
        typeof prefs.forecastModel === "string" &&
        ID_RE.test(prefs.forecastModel)
          ? prefs.forecastModel
          : "best_match",
      homeLocation: home,
    },
  };
}

/**
 * Register or refresh the caller's own device on the platform
 * (`PUT /v1/devices/mine/{deviceId}`, proposed ask 1). `sessionId` is the
 * caller's own WorkOS session (its OIDC `sid`), filled in by the route from the AuthKit
 * session so that revoking the device can end it.
 */
export function createPlatformDevicesClient(
  transport: () => GatewayTransport | null,
) {
  return {
    async register(
      personToken: string,
      registration: DeviceRegistration,
      sessionId: string | undefined,
    ): Promise<void> {
      const send = transport();
      if (!send) throw new DevicesError(503, "devices_unavailable");
      let response: Response;
      try {
        response = await send(
          gatewayRequest(
            `/v1/devices/mine/${encodeURIComponent(registration.deviceId)}`,
            {
              method: "PUT",
              headers: {
                accept: "application/json",
                "content-type": "application/json",
                authorization: `Bearer ${personToken}`,
              },
              body: JSON.stringify({
                ...toPlatformRecord(registration, sessionId),
                deviceId: registration.deviceId,
                permissions: registration.permissions,
                preferences: registration.preferences,
              }),
            },
          ),
        );
      } catch {
        throw new DevicesError(503, "devices_unavailable");
      }
      if (response.status === 429) {
        throw new DevicesError(
          429,
          "rate_limited",
          parseRetryAfter(response.headers.get("retry-after")),
        );
      }
      // A missing route (404/405) is "not built yet", the same as down.
      if (response.status >= 300)
        throw new DevicesError(503, "devices_unavailable");
    },
  };
}

export interface RegisterDeps {
  /** `PLATFORM_DEVICES_READY` in production. */
  ready: boolean;
  /** A devices-scoped person token (not mintable yet: ask 5 of #320). */
  token: () => Promise<string>;
  client: Pick<ReturnType<typeof createPlatformDevicesClient>, "register">;
}

/**
 * Register the caller's device, or say plainly that the platform cannot take
 * it yet. When it cannot, nothing is exchanged, sent or stored.
 */
export async function registerWithPlatform(
  registration: DeviceRegistration,
  sessionId: string | undefined,
  deps: RegisterDeps,
): Promise<void> {
  if (!deps.ready) throw new DevicesError(503, "devices_unavailable");
  await deps.client.register(await deps.token(), registration, sessionId);
}
