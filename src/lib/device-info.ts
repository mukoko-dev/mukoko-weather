/**
 * What we say about a device, from its user agent. Pure, so it runs in the
 * browser (this device), on the server (the WorkOS session list) and in tests.
 *
 * Only a coarse label comes out: operating system, browser and form factor.
 * The raw user agent string is never stored or returned, and an IP address is
 * never read here at all.
 *
 * Names follow the standards: `DeviceOs` values are the platform names the
 * User-Agent Client Hints spec recommends for `Sec-CH-UA-Platform` ("iOS",
 * "Chrome OS", ...), and `DisplayMode` is the W3C Web App Manifest display
 * mode list. The platform names below follow the `device.devices` validator enum
 * (`bundu.userDevice.platformIdentifier`: ios, android, macos, windows,
 * linux, web_chrome, web_firefox, web_safari, web_other) so a platform
 * registration can reuse them unchanged.
 */

export type DeviceOs =
  | "iOS"
  | "Android"
  | "macOS"
  | "Windows"
  | "Linux"
  | "Chrome OS"
  | "Unknown";

export type DeviceBrowser =
  | "Safari"
  | "Chrome"
  | "Firefox"
  | "Edge"
  | "Opera"
  | "Samsung Internet"
  | "Other";

export type DeviceFormFactor = "phone" | "tablet" | "desktop";

export interface ParsedDevice {
  os: DeviceOs;
  browser: DeviceBrowser;
  formFactor: DeviceFormFactor;
}

export type WebPlatform =
  | "web_chrome"
  | "web_firefox"
  | "web_safari"
  | "web_other";

const MAX_UA = 512;

/** `Sec-CH-UA-Platform` values the spec recommends, as our `DeviceOs`. */
const HINT_PLATFORMS: Record<string, DeviceOs | undefined> = {
  Android: "Android",
  "Chrome OS": "Chrome OS",
  iOS: "iOS",
  Linux: "Linux",
  macOS: "macOS",
  Windows: "Windows",
};

function parseOs(ua: string): DeviceOs {
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  if (/CrOS/i.test(ua)) return "Chrome OS";
  if (/Windows/i.test(ua)) return "Windows";
  // iPadOS 13+ reports a Mac; it cannot be told apart from the user agent.
  if (/Macintosh|Mac OS X/i.test(ua)) return "macOS";
  if (/Linux|X11/i.test(ua)) return "Linux";
  return "Unknown";
}

function parseBrowser(ua: string): DeviceBrowser {
  // Order matters: most of these also say "Chrome" or "Safari".
  if (/EdgA?\/|EdgiOS\//.test(ua)) return "Edge";
  if (/OPR\/|OPiOS\//.test(ua)) return "Opera";
  if (/SamsungBrowser\//.test(ua)) return "Samsung Internet";
  if (/Firefox\/|FxiOS\//.test(ua)) return "Firefox";
  if (/Chrome\/|CriOS\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return "Safari";
  return "Other";
}

function parseFormFactor(ua: string, os: DeviceOs): DeviceFormFactor {
  if (/iPad|Tablet/i.test(ua)) return "tablet";
  if (/iPhone|iPod/i.test(ua)) return "phone";
  if (os === "Android") return /Mobile/i.test(ua) ? "phone" : "tablet";
  return "desktop";
}

/** A coarse description of a user agent. Unknown input never throws. */
export function parseUserAgent(
  userAgent: string | null | undefined,
  hints?: ClientHints,
): ParsedDevice {
  const ua = (userAgent ?? "").slice(0, MAX_UA);
  const hinted = hints?.platform ? HINT_PLATFORMS[hints.platform] : undefined;
  const os = hinted ?? parseOs(ua);
  let formFactor = parseFormFactor(ua, os);
  // Sec-CH-UA-Mobile is authoritative for "phone"; it cannot say "tablet".
  if (hints?.mobile === true && !/iPad|Tablet/i.test(ua)) formFactor = "phone";
  return { os, browser: parseBrowser(ua), formFactor };
}

/** "Safari on iOS", or just the browser when the system is unknown. */
export function deviceLabel(device: ParsedDevice): string {
  if (device.os === "Unknown") {
    return device.browser === "Other" ? "Unknown device" : device.browser;
  }
  if (device.browser === "Other") return device.os;
  return `${device.browser} on ${device.os}`;
}

/** The validator's web platform id for a browser. */
export function webPlatform(device: ParsedDevice): WebPlatform {
  switch (device.browser) {
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

/** W3C Web App Manifest display modes (the `display-mode` media feature). */
export type DisplayMode =
  | "fullscreen"
  | "standalone"
  | "minimal-ui"
  | "browser";

const DISPLAY_MODES: readonly DisplayMode[] = [
  "fullscreen",
  "standalone",
  "minimal-ui",
];

interface DisplayWindow {
  navigator?: object;
  matchMedia?: (query: string) => { matches: boolean };
}

/**
 * The applied display mode. iOS home-screen apps report it through
 * `navigator.standalone` (no media query before iOS 11.3); everything else
 * through `(display-mode: ...)`. `browser` is the spec default.
 */
export function displayMode(
  win: DisplayWindow | null = typeof window === "undefined" ? null : window,
): DisplayMode {
  if (!win) return "browser";
  try {
    if (
      (win.navigator as { standalone?: boolean } | undefined)?.standalone ===
      true
    ) {
      return "standalone";
    }
    for (const mode of DISPLAY_MODES) {
      if (win.matchMedia?.(`(display-mode: ${mode})`).matches === true) {
        return mode;
      }
    }
  } catch {
    /* fall through */
  }
  return "browser";
}

/** True when running as an installed app (standalone or fullscreen). */
export function isStandalone(win?: DisplayWindow | null): boolean {
  const mode = displayMode(win);
  return mode === "standalone" || mode === "fullscreen";
}

/** Low-entropy User-Agent Client Hints (`navigator.userAgentData`). */
export interface ClientHints {
  platform?: string;
  mobile?: boolean;
}

export function readClientHints(
  nav: object | null = typeof navigator === "undefined" ? null : navigator,
): ClientHints | undefined {
  const d = (nav as { userAgentData?: ClientHints } | null)?.userAgentData;
  if (!d) return undefined;
  return {
    platform: typeof d.platform === "string" ? d.platform : undefined,
    mobile: typeof d.mobile === "boolean" ? d.mobile : undefined,
  };
}
