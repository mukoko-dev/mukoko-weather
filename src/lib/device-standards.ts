/**
 * The device record in standard vocabularies, and the one place it is mapped
 * to the platform's own names.
 *
 * Standards used (each checked against the live spec on 2026-10-17):
 * - W3C Permissions: `PermissionState` is exactly granted | denied | prompt,
 *   and the registry names are "geolocation", "notifications", "push".
 * - W3C Web App Manifest: display modes fullscreen | standalone | minimal-ui |
 *   browser, reflected by the `display-mode` media feature.
 * - User-Agent Client Hints: `Sec-CH-UA-Platform` recommended values
 *   ("Android", "Chrome OS", "Fuchsia", "iOS", "Linux", "macOS", "Windows",
 *   "Unknown"); `Sec-CH-UA-Form-Factors` values "Desktop", "Mobile", "Tablet"
 *   (also Automotive, XR, EInk, Watch, unused here).
 * - OpenID Connect: `sid`, an opaque session identifier.
 * - ISO 8601 timestamps, BCP 47 `locale`, IANA `timeZone`.
 * - schema.org JSON-LD (`deviceJsonLd`): WebApplication (a SoftwareApplication
 *   and so a CreativeWork: operatingSystem, permissions, dateCreated,
 *   dateModified), Person.identifier / Person.owns, RegisterAction.
 *
 * App-level states the standards do not have (`dismissed` = "Not now" on our
 * own card, `unsupported` = API absent) stay on the device. On the wire a
 * dismissal is `prompt` plus `promptDismissedAt`; "unsupported" is omitted.
 */

import type {
  DeviceBrowser,
  DeviceFormFactor,
  DeviceOs,
  DisplayMode,
  WebPlatform,
} from "./device-info";
import type {
  PermissionKind,
  StoredPermission,
  StoredPermissionState,
} from "./device-state";

/** W3C `PermissionState`. */
export type PermissionStateW3C = "granted" | "denied" | "prompt";

/** `Sec-CH-UA-Form-Factors` values this app can produce. */
export type UaChFormFactor = "Desktop" | "Mobile" | "Tablet";

export interface PermissionReport {
  state: PermissionStateW3C;
  /** ISO 8601, when the state last changed. */
  changedAt: string;
  /** ISO 8601, set when the visitor said "Not now" and was never prompted. */
  promptDismissedAt?: string;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A stored permission as the standard wire shape, or null when it has none. */
export function toPermissionReport(
  p: StoredPermission | null,
): PermissionReport | null {
  if (!p || !Number.isFinite(p.changedAt)) return null;
  const at = iso(p.changedAt);
  const s: StoredPermissionState = p.state;
  if (s === "unsupported") return null;
  if (s === "dismissed") {
    return { state: "prompt", changedAt: at, promptDismissedAt: at };
  }
  return { state: s, changedAt: at };
}

export const PERMISSION_NAMES: readonly PermissionKind[] = [
  "geolocation",
  "notifications",
];

export function toUaChFormFactor(ff: DeviceFormFactor): UaChFormFactor {
  return ff === "phone" ? "Mobile" : ff === "tablet" ? "Tablet" : "Desktop";
}

export function fromUaChFormFactor(v: unknown): DeviceFormFactor {
  return v === "Mobile" ? "phone" : v === "Tablet" ? "tablet" : "desktop";
}

export const UA_CH_PLATFORMS: readonly DeviceOs[] = [
  "Android",
  "Chrome OS",
  "iOS",
  "Linux",
  "macOS",
  "Windows",
  "Unknown",
];

export const DISPLAY_MODE_VALUES: readonly DisplayMode[] = [
  "fullscreen",
  "standalone",
  "minimal-ui",
  "browser",
];

/** What the client reports: standard names only. */
export interface StandardDevice {
  deviceId: string;
  name: string;
  /** `Sec-CH-UA-Platform` value. */
  platform: DeviceOs;
  browser: DeviceBrowser;
  /** `Sec-CH-UA-Form-Factors` value. */
  formFactor: UaChFormFactor;
  /** W3C display mode. */
  displayMode: DisplayMode;
  /** BCP 47. */
  locale: string;
  /** IANA time zone. */
  timeZone: string;
}

/** The platform's own record (`bundu.userDevice` names, proposed in #320). */
export interface PlatformDeviceRecord {
  displayName: string;
  platformIdentifier: WebPlatform;
  /** Platform enum: phone, tablet, laptop, desktop, workstation, browser_persistent. */
  formFactor: "phone" | "tablet" | "desktop" | "browser_persistent";
  osName: DeviceOs;
  standalone: boolean;
  /** OIDC `sid` of the session that registered the device. */
  currentSessionId?: string;
  locale: string;
  timeZone: string;
}

function browserPlatform(browser: DeviceBrowser): WebPlatform {
  switch (browser) {
    case "Chrome":
      return "web_chrome";
    case "Firefox":
      return "web_firefox";
    case "Safari":
      return "web_safari";
    default:
      return "web_other";
  }
}

/**
 * The thin mapper to the platform's names. A browser tab is a
 * `browser_persistent` device on a `web_*` platform; an installed app
 * (standalone / fullscreen) takes the real form factor.
 */
export function toPlatformRecord(
  d: StandardDevice,
  sid: string | undefined,
): PlatformDeviceRecord {
  const installed =
    d.displayMode === "standalone" || d.displayMode === "fullscreen";
  const ff = fromUaChFormFactor(d.formFactor);
  return {
    displayName: d.name,
    platformIdentifier: browserPlatform(d.browser),
    formFactor: installed ? ff : "browser_persistent",
    osName: d.platform,
    standalone: installed,
    ...(sid ? { currentSessionId: sid } : {}),
    locale: d.locale,
    timeZone: d.timeZone,
  };
}

export interface DeviceJsonLdInput extends StandardDevice {
  personId: string;
  registeredAt: number;
  lastSeenAt: number;
  permissions: Partial<Record<PermissionKind, PermissionReport | null>>;
}

/**
 * schema.org JSON-LD for a registered device. Mapping only: nothing renders it
 * on a page, and it carries no position, address or user agent.
 *
 * Does not fit and is not used: Product / IndividualProduct (`model`,
 * `manufacturer`, `serialNumber`) describe hardware, and a browser exposes
 * none of it without high-entropy hints and fingerprinting risk, so they are
 * never collected; RFC 8628 is a different flow (household displays).
 */
export function deviceJsonLd(d: DeviceJsonLdInput): Record<string, unknown> {
  const granted = PERMISSION_NAMES.filter(
    (n) => d.permissions[n]?.state === "granted",
  );
  const app = {
    "@type": "WebApplication",
    identifier: d.deviceId,
    name: d.name,
    operatingSystem: d.platform,
    additionalType: d.formFactor,
    permissions: granted.join(", ") || undefined,
    inLanguage: d.locale,
    dateCreated: iso(d.registeredAt),
    dateModified: iso(d.lastSeenAt),
  };
  return {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Person", identifier: d.personId, owns: app },
      {
        "@type": "RegisterAction",
        agent: { "@type": "Person", identifier: d.personId },
        object: { "@type": "WebApplication", identifier: d.deviceId },
        startTime: iso(d.registeredAt),
        actionStatus: "https://schema.org/CompletedActionStatus",
      },
    ],
  };
}
