import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getRetryCount, setRetryCount, clearRetryCount, MAX_RETRIES } from "./error-retry";

// Mock sessionStorage and window.location for Node test environment
const mockStorage: Record<string, string> = {};
const mockSessionStorage = {
  getItem: vi.fn((key: string) => mockStorage[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { mockStorage[key] = value; }),
  removeItem: vi.fn((key: string) => { delete mockStorage[key]; }),
};

describe("error-retry", () => {
  beforeEach(() => {
    // Clear mock storage
    for (const key of Object.keys(mockStorage)) {
      delete mockStorage[key];
    }
    vi.clearAllMocks();

    // Setup global sessionStorage and window.location
    Object.defineProperty(globalThis, "sessionStorage", {
      value: mockSessionStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: {
        location: { href: "https://weather.mukoko.com/harare" },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("MAX_RETRIES", () => {
    it("equals 3", () => {
      expect(MAX_RETRIES).toBe(3);
    });
  });

  describe("getRetryCount", () => {
    it("returns 0 when sessionStorage is empty", () => {
      expect(getRetryCount()).toBe(0);
    });

    it("returns the stored count when URL matches", () => {
      mockStorage["mukoko-error-retries"] = JSON.stringify({
        url: "https://weather.mukoko.com/harare",
        count: 2,
      });
      expect(getRetryCount()).toBe(2);
    });

    it("returns 0 when URL does not match", () => {
      mockStorage["mukoko-error-retries"] = JSON.stringify({
        url: "https://weather.mukoko.com/bulawayo",
        count: 2,
      });
      expect(getRetryCount()).toBe(0);
    });

    it("returns 0 when stored value is invalid JSON", () => {
      mockStorage["mukoko-error-retries"] = "not-json";
      expect(getRetryCount()).toBe(0);
    });

    it("returns 0 when sessionStorage throws", () => {
      mockSessionStorage.getItem.mockImplementationOnce(() => {
        throw new Error("Storage unavailable");
      });
      expect(getRetryCount()).toBe(0);
    });
  });

  describe("setRetryCount", () => {
    it("stores count and URL in sessionStorage", () => {
      setRetryCount(2);
      expect(mockSessionStorage.setItem).toHaveBeenCalledWith(
        "mukoko-error-retries",
        JSON.stringify({ url: "https://weather.mukoko.com/harare", count: 2 }),
      );
    });

    it("does not throw when sessionStorage is unavailable", () => {
      mockSessionStorage.setItem.mockImplementationOnce(() => {
        throw new Error("Storage unavailable");
      });
      expect(() => setRetryCount(1)).not.toThrow();
    });
  });

  describe("clearRetryCount", () => {
    it("removes the key from sessionStorage", () => {
      mockStorage["mukoko-error-retries"] = "something";
      clearRetryCount();
      expect(mockSessionStorage.removeItem).toHaveBeenCalledWith(
        "mukoko-error-retries",
      );
    });

    it("does not throw when sessionStorage is unavailable", () => {
      mockSessionStorage.removeItem.mockImplementationOnce(() => {
        throw new Error("Storage unavailable");
      });
      expect(() => clearRetryCount()).not.toThrow();
    });
  });
});
