import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeBanner,
  isBannerClosed,
  resetBanners,
  subscribeToBanners,
} from "./banner-dismissal";

/** A `sessionStorage` that keeps its values across `resetBanners` (a reload). */
function fakeStorage(overrides: Partial<Storage> = {}): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", fakeStorage());
  resetBanners();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetBanners();
});

describe("banner dismissal — which banners are closed", () => {
  it("shows a banner nobody has closed", () => {
    expect(isBannerClosed("frost:high:x", "session")).toBe(false);
    expect(isBannerClosed("frost:high:x", "visit")).toBe(false);
  });

  it("keeps a closed banner closed for the visit, and writes nothing to the tab", () => {
    closeBanner("unavailable:a", "visit");
    expect(isBannerClosed("unavailable:a", "visit")).toBe(true);
    expect(sessionStorage.length).toBe(0);
    // A reload forgets it: the page is a new visit.
    resetBanners();
    expect(isBannerClosed("unavailable:a", "visit")).toBe(false);
  });

  it("keeps a session banner closed through a reload, in the tab's own storage only", () => {
    closeBanner("frost:high:x", "session");
    expect(sessionStorage.length).toBe(1);
    resetBanners(); // the page reloads: memory is gone, the tab's storage is not
    expect(isBannerClosed("frost:high:x", "session")).toBe(true);
  });

  it("treats a different id as a different message: a new frost risk shows again", () => {
    closeBanner("frost:moderate:cold tonight", "session");
    expect(isBannerClosed("frost:severe:hard frost tonight", "session")).toBe(
      false,
    );
  });

  it("tells every subscriber when a banner is closed, and stops after unsubscribe", () => {
    const seen = vi.fn();
    const stop = subscribeToBanners(seen);
    closeBanner("a", "visit");
    expect(seen).toHaveBeenCalledTimes(1);
    stop();
    closeBanner("b", "visit");
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe("banner dismissal — storage that fails", () => {
  it("still closes the banner for the visit when storage is full", () => {
    vi.stubGlobal(
      "sessionStorage",
      fakeStorage({
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      }),
    );
    expect(() => closeBanner("frost:high:x", "session")).not.toThrow();
    expect(isBannerClosed("frost:high:x", "session")).toBe(true);
  });

  it("shows the banner when reading storage throws (blocked storage)", () => {
    vi.stubGlobal(
      "sessionStorage",
      fakeStorage({
        getItem: () => {
          throw new Error("SecurityError");
        },
      }),
    );
    expect(isBannerClosed("frost:high:x", "session")).toBe(false);
  });

  it("works where there is no sessionStorage at all (the server)", () => {
    vi.stubGlobal("sessionStorage", undefined);
    expect(isBannerClosed("a", "session")).toBe(false);
    expect(() => closeBanner("a", "session")).not.toThrow();
    expect(isBannerClosed("a", "session")).toBe(true);
  });
});
