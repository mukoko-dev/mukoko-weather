/**
 * What we say about a device, from its user agent. Pure, so it runs in the
 * browser (this device), on the server (the WorkOS session list) and in tests.
 *
 * Only a coarse label comes out: operating system, browser and form factor.
 * The raw user agent string is never stored or returned, and an IP address is
 * never read here at all.
 *
 * The platform names follow the `device.devices` validator enum
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
  | "ChromeOS"
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

function parseOs(ua: string): DeviceOs {
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  if (/CrOS/i.test(ua)) return "ChromeOS";
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
): ParsedDevice {
  const ua = (userAgent ?? "").slice(0, MAX_UA);
  const os = parseOs(ua);
  return { os, browser: parseBrowser(ua), formFactor: parseFormFactor(ua, os) };
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

/**
 * True when the page runs as an installed app (home-screen web app). iOS
 * reports it through `navigator.standalone`, everything else through the
 * display-mode media query.
 */
export function isStandalone(
  win: {
    navigator?: object;
    matchMedia?: (query: string) => { matches: boolean };
  } | null = typeof window === "undefined" ? null : window,
): boolean {
  if (!win) return false;
  try {
    if (
      (win.navigator as { standalone?: boolean } | undefined)?.standalone ===
      true
    ) {
      return true;
    }
    return win.matchMedia?.("(display-mode: standalone)").matches === true;
  } catch {
    return false;
  }
}
