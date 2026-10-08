/**
 * Tests for the activity catalogue client: 10-minute cache, in-flight
 * de-duplication, and empty-array fallback on failure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  fetchActivities,
  fetchActivityCategories,
  resetActivitiesClientCache,
} from "./activities-client";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const ACTIVITY = { id: "soccer", label: "Soccer", category: "sports" };
const CATEGORY = { id: "farming", label: "Farming" };

function okJson(body: unknown) {
  return { ok: true, json: async () => body };
}

beforeEach(() => {
  mockFetch.mockReset();
  resetActivitiesClientCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchActivities", () => {
  it("requests /api/py/activities and returns the list", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ activities: [ACTIVITY] }));
    await expect(fetchActivities()).resolves.toEqual([ACTIVITY]);
    expect(mockFetch.mock.calls[0][0]).toBe("/api/py/activities");
  });

  it("serves repeat calls from cache within 10 minutes", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ activities: [ACTIVITY] }));
    await fetchActivities();
    await fetchActivities();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ activities: [ACTIVITY] }));
    const [a, b] = await Promise.all([fetchActivities(), fetchActivities()]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("refetches after the 10-minute TTL expires", async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue(okJson({ activities: [ACTIVITY] }));
    await fetchActivities();
    vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);
    await fetchActivities();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns [] on a non-OK response and does not cache the failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    await expect(fetchActivities()).resolves.toEqual([]);
    mockFetch.mockResolvedValueOnce(okJson({ activities: [ACTIVITY] }));
    await expect(fetchActivities()).resolves.toEqual([ACTIVITY]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns [] on a network error", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("offline"));
    await expect(fetchActivities()).resolves.toEqual([]);
  });

  it("returns [] when the response has no activities array", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ activities: [] }));
    await expect(fetchActivities()).resolves.toEqual([]);
  });
});

describe("fetchActivityCategories", () => {
  it("requests the categories mode and returns the list", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ categories: [CATEGORY] }));
    await expect(fetchActivityCategories()).resolves.toEqual([CATEGORY]);
    expect(mockFetch.mock.calls[0][0]).toBe(
      "/api/py/activities?mode=categories",
    );
  });

  it("caches categories independently of activities", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ categories: [CATEGORY] }));
    mockFetch.mockResolvedValueOnce(okJson({ activities: [ACTIVITY] }));
    await fetchActivityCategories();
    await fetchActivities();
    await fetchActivityCategories();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns [] on failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    await expect(fetchActivityCategories()).resolves.toEqual([]);
  });
});

describe("resetActivitiesClientCache", () => {
  it("forces the next call back to the network", async () => {
    mockFetch.mockResolvedValue(okJson({ categories: [CATEGORY] }));
    await fetchActivityCategories();
    resetActivitiesClientCache();
    await fetchActivityCategories();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
