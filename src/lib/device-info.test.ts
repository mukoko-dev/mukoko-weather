import { describe, it, expect } from "vitest";
import {
  deviceLabel,
  isStandalone,
  parseUserAgent,
  webPlatform,
} from "./device-info";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 14; SM-X900) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  samsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  winEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  linuxFirefox:
    "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
};

describe("parseUserAgent", () => {
  it("reads iPhone Safari", () => {
    expect(parseUserAgent(UA.iphoneSafari)).toEqual({
      os: "iOS",
      browser: "Safari",
      formFactor: "phone",
    });
  });
  it("tells iOS Chrome from Safari", () => {
    expect(parseUserAgent(UA.iphoneChrome).browser).toBe("Chrome");
  });
  it("reads an iPad as a tablet", () => {
    expect(parseUserAgent(UA.ipad).formFactor).toBe("tablet");
  });
  it("separates an Android phone from an Android tablet by Mobile", () => {
    expect(parseUserAgent(UA.androidChrome).formFactor).toBe("phone");
    expect(parseUserAgent(UA.androidTablet).formFactor).toBe("tablet");
  });
  it("checks the specific browsers before Chrome and Safari", () => {
    expect(parseUserAgent(UA.samsung).browser).toBe("Samsung Internet");
    expect(parseUserAgent(UA.winEdge).browser).toBe("Edge");
  });
  it("reads desktop systems", () => {
    expect(parseUserAgent(UA.macSafari)).toMatchObject({
      os: "macOS",
      browser: "Safari",
      formFactor: "desktop",
    });
    expect(parseUserAgent(UA.winEdge).os).toBe("Windows");
    expect(parseUserAgent(UA.linuxFirefox)).toMatchObject({
      os: "Linux",
      browser: "Firefox",
    });
  });
  it("never throws on missing, odd or huge input", () => {
    expect(parseUserAgent(null)).toEqual({
      os: "Unknown",
      browser: "Other",
      formFactor: "desktop",
    });
    expect(parseUserAgent("")).toMatchObject({ os: "Unknown" });
    expect(() => parseUserAgent("x".repeat(100_000))).not.toThrow();
  });
  it("ignores everything past 512 characters", () => {
    expect(parseUserAgent("x".repeat(600) + " iPhone").os).toBe("Unknown");
  });
});

describe("deviceLabel and webPlatform", () => {
  it("labels browser on system", () => {
    expect(deviceLabel(parseUserAgent(UA.iphoneSafari))).toBe("Safari on iOS");
  });
  it("degrades without lying", () => {
    expect(deviceLabel(parseUserAgent(null))).toBe("Unknown device");
    expect(
      deviceLabel({ os: "Unknown", browser: "Firefox", formFactor: "desktop" }),
    ).toBe("Firefox");
    expect(
      deviceLabel({ os: "Linux", browser: "Other", formFactor: "desktop" }),
    ).toBe("Linux");
  });
  it("maps to the platform validator's web ids", () => {
    expect(webPlatform(parseUserAgent(UA.iphoneSafari))).toBe("web_safari");
    expect(webPlatform(parseUserAgent(UA.androidChrome))).toBe("web_chrome");
    expect(webPlatform(parseUserAgent(UA.linuxFirefox))).toBe("web_firefox");
    expect(webPlatform(parseUserAgent(UA.winEdge))).toBe("web_other");
  });
});

describe("isStandalone", () => {
  it("is true for iOS navigator.standalone", () => {
    expect(isStandalone({ navigator: { standalone: true } })).toBe(true);
  });
  it("is true for the display-mode media query", () => {
    expect(
      isStandalone({
        navigator: {},
        matchMedia: (q) => ({ matches: q === "(display-mode: standalone)" }),
      }),
    ).toBe(true);
  });
  it("is false in a tab, with no window, or when the query throws", () => {
    expect(
      isStandalone({ navigator: {}, matchMedia: () => ({ matches: false }) }),
    ).toBe(false);
    expect(isStandalone(null)).toBe(false);
    expect(
      isStandalone({
        matchMedia: () => {
          throw new Error("no");
        },
      }),
    ).toBe(false);
  });
});
