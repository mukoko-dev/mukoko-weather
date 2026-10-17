/**
 * Pins the device record to the standards it claims (names and enum values
 * checked against the live specs on 2026-10-17) and to the platform's own
 * enums, so the two cannot drift apart silently.
 */
import { describe, it, expect } from "vitest";
import {
  deviceJsonLd,
  fromUaChFormFactor,
  toPermissionReport,
  toPlatformRecord,
  toUaChFormFactor,
  UA_CH_PLATFORMS,
  type StandardDevice,
} from "./device-standards";
import { displayMode, parseUserAgent, readClientHints } from "./device-info";

const base: StandardDevice = {
  deviceId: "11111111-2222-4333-8444-555555555555",
  name: "Safari on iOS",
  platform: "iOS",
  browser: "Safari",
  formFactor: "Mobile",
  displayMode: "standalone",
  locale: "en-ZW",
  timeZone: "Africa/Harare",
};

describe("W3C Permissions", () => {
  it("uses exactly PermissionState granted | denied | prompt on the wire", () => {
    const at = Date.UTC(2026, 9, 17, 12);
    expect(toPermissionReport({ state: "granted", changedAt: at })).toEqual({
      state: "granted",
      changedAt: "2026-10-17T12:00:00.000Z",
    });
    expect(toPermissionReport({ state: "denied", changedAt: at })?.state).toBe(
      "denied",
    );
    expect(toPermissionReport({ state: "prompt", changedAt: at })?.state).toBe(
      "prompt",
    );
  });
  it("keeps app-only states off the wire: dismissed is prompt + promptDismissedAt, unsupported is omitted", () => {
    const at = 1000;
    expect(toPermissionReport({ state: "dismissed", changedAt: at })).toEqual({
      state: "prompt",
      changedAt: "1970-01-01T00:00:01.000Z",
      promptDismissedAt: "1970-01-01T00:00:01.000Z",
    });
    expect(
      toPermissionReport({ state: "unsupported", changedAt: at }),
    ).toBeNull();
    expect(toPermissionReport(null)).toBeNull();
  });
});

describe("User-Agent Client Hints", () => {
  it("platform names are the Sec-CH-UA-Platform recommended values", () => {
    expect([...UA_CH_PLATFORMS].sort()).toEqual(
      [
        "Android",
        "Chrome OS",
        "Linux",
        "Unknown",
        "Windows",
        "iOS",
        "macOS",
      ].sort(),
    );
    expect(parseUserAgent("Mozilla/5.0 (X11; CrOS x86_64 1.0)").os).toBe(
      "Chrome OS",
    );
  });
  it("form factors are Desktop | Mobile | Tablet and round-trip", () => {
    expect(toUaChFormFactor("phone")).toBe("Mobile");
    expect(toUaChFormFactor("tablet")).toBe("Tablet");
    expect(toUaChFormFactor("desktop")).toBe("Desktop");
    for (const v of ["Mobile", "Tablet", "Desktop"] as const) {
      expect(toUaChFormFactor(fromUaChFormFactor(v))).toBe(v);
    }
  });
  it("prefers the low-entropy hints over the user agent string", () => {
    const d = parseUserAgent("Mozilla/5.0 (X11; Linux x86_64)", {
      platform: "Android",
      mobile: true,
    });
    expect(d).toMatchObject({ os: "Android", formFactor: "phone" });
    expect(
      readClientHints({ userAgentData: { platform: "macOS", mobile: false } }),
    ).toEqual({
      platform: "macOS",
      mobile: false,
    });
    expect(readClientHints({})).toBeUndefined();
  });
});

describe("W3C Web App Manifest display modes", () => {
  const win = (on: string) => ({
    navigator: {},
    matchMedia: (q: string) => ({ matches: q === `(display-mode: ${on})` }),
  });
  it("reflects the applied display-mode media feature", () => {
    for (const m of ["fullscreen", "standalone", "minimal-ui"] as const) {
      expect(displayMode(win(m))).toBe(m);
    }
    expect(displayMode(win("browser"))).toBe("browser");
    expect(displayMode(null)).toBe("browser");
    expect(displayMode({ navigator: { standalone: true } })).toBe("standalone");
  });
});

describe("mapper to the platform record (names stay the platform's)", () => {
  it("a browser tab is browser_persistent on a web_* platform", () => {
    expect(
      toPlatformRecord({ ...base, displayMode: "browser" }, "sid_1"),
    ).toEqual({
      displayName: "Safari on iOS",
      platformIdentifier: "web_safari",
      formFactor: "browser_persistent",
      osName: "iOS",
      standalone: false,
      currentSessionId: "sid_1",
      locale: "en-ZW",
      timeZone: "Africa/Harare",
    });
  });
  it("an installed app keeps its real form factor", () => {
    expect(toPlatformRecord(base, undefined)).toMatchObject({
      formFactor: "phone",
      standalone: true,
    });
    expect(
      toPlatformRecord({ ...base, formFactor: "Tablet" }, undefined).formFactor,
    ).toBe("tablet");
  });
  it("only emits values in the platform's enums", () => {
    const platforms = new Set([
      "web_chrome",
      "web_firefox",
      "web_safari",
      "web_other",
    ]);
    const ffs = new Set(["phone", "tablet", "desktop", "browser_persistent"]);
    for (const browser of [
      "Safari",
      "Chrome",
      "Firefox",
      "Edge",
      "Opera",
      "Samsung Internet",
      "Other",
    ] as const) {
      for (const dm of [
        "browser",
        "standalone",
        "fullscreen",
        "minimal-ui",
      ] as const) {
        const r = toPlatformRecord(
          { ...base, browser, displayMode: dm },
          undefined,
        );
        expect(platforms.has(r.platformIdentifier)).toBe(true);
        expect(ffs.has(r.formFactor)).toBe(true);
      }
    }
  });
});

describe("schema.org JSON-LD", () => {
  const ld = deviceJsonLd({
    ...base,
    personId: "person-1",
    registeredAt: Date.UTC(2026, 9, 1),
    lastSeenAt: Date.UTC(2026, 9, 17),
    permissions: {
      geolocation: { state: "granted", changedAt: "2026-10-01T00:00:00.000Z" },
      notifications: { state: "prompt", changedAt: "2026-10-01T00:00:00.000Z" },
    },
  }) as { "@context": string; "@graph": Record<string, any>[] };
  const [person, action] = ld["@graph"];
  it("maps to Person.owns a WebApplication with schema.org properties", () => {
    expect(ld["@context"]).toBe("https://schema.org");
    expect(person).toMatchObject({ "@type": "Person", identifier: "person-1" });
    expect(person.owns).toMatchObject({
      "@type": "WebApplication",
      identifier: base.deviceId,
      name: "Safari on iOS",
      operatingSystem: "iOS",
      permissions: "geolocation",
      inLanguage: "en-ZW",
      dateCreated: "2026-10-01T00:00:00.000Z",
      dateModified: "2026-10-17T00:00:00.000Z",
    });
  });
  it("records registration as a completed RegisterAction", () => {
    expect(action).toMatchObject({
      "@type": "RegisterAction",
      startTime: "2026-10-01T00:00:00.000Z",
      actionStatus: "https://schema.org/CompletedActionStatus",
    });
  });
  it("carries no position, address, user agent or hardware serial", () => {
    const json = JSON.stringify(ld);
    for (const k of [
      "serialNumber",
      "manufacturer",
      "userAgent",
      "ipAddress",
      "latitude",
    ]) {
      expect(json).not.toContain(k);
    }
  });
});
