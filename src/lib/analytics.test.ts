import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Use vi.hoisted() to ensure mockTrack is available before vi.mock runs
const mockTrack = vi.hoisted(() => vi.fn());
vi.mock("@vercel/analytics", () => ({ track: mockTrack }));

import { trackEvent, type AnalyticsEvents } from "./analytics";

describe("analytics", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let originalWindow: any;

  beforeEach(() => {
    originalWindow = globalThis.window;
    mockTrack.mockClear();
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      // @ts-expect-error — restoring undefined for SSR simulation
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  });

  describe("trackEvent", () => {
    it("no-ops when window is undefined (server-side)", () => {
      // @ts-expect-error — simulate SSR
      delete globalThis.window;

      trackEvent("report_submitted", {
        type: "heavy-rain",
        severity: "moderate",
        location: "harare",
      });

      expect(mockTrack).not.toHaveBeenCalled();
    });

    it("fires Vercel Analytics track() with correct name and properties", () => {
      // @ts-expect-error — minimal window mock
      globalThis.window = {};

      trackEvent("location_saved", { slug: "harare" });

      expect(mockTrack).toHaveBeenCalledWith("location_saved", {
        slug: "harare",
      });
    });

    it("fires GA4 gtag() with correct event name and properties", () => {
      const mockGtag = vi.fn();
      // @ts-expect-error — minimal window mock with gtag
      globalThis.window = { gtag: mockGtag };

      trackEvent("theme_changed", { theme: "dark" });

      expect(mockGtag).toHaveBeenCalledWith("event", "theme_changed", {
        theme: "dark",
      });
    });

    it("fires both GA4 and Vercel Analytics for a single event", () => {
      const mockGtag = vi.fn();
      // @ts-expect-error — minimal window mock with gtag
      globalThis.window = { gtag: mockGtag };

      trackEvent("activity_toggled", {
        activityId: "farming-maize",
        enabled: true,
      });

      expect(mockTrack).toHaveBeenCalledTimes(1);
      expect(mockGtag).toHaveBeenCalledTimes(1);
      expect(mockTrack).toHaveBeenCalledWith("activity_toggled", {
        activityId: "farming-maize",
        enabled: true,
      });
      expect(mockGtag).toHaveBeenCalledWith("event", "activity_toggled", {
        activityId: "farming-maize",
        enabled: true,
      });
    });

    it("silently continues if gtag is not defined", () => {
      // @ts-expect-error — window without gtag
      globalThis.window = {};

      expect(() => {
        trackEvent("modal_opened", { modal: "my-weather" });
      }).not.toThrow();

      // Vercel track should still fire
      expect(mockTrack).toHaveBeenCalledWith("modal_opened", {
        modal: "my-weather",
      });
    });

    it("silently continues if Vercel track() throws", () => {
      mockTrack.mockImplementation(() => {
        throw new Error("Vercel Analytics unavailable");
      });

      const mockGtag = vi.fn();
      // @ts-expect-error — minimal window mock with gtag
      globalThis.window = { gtag: mockGtag };

      expect(() => {
        trackEvent("explore_search", { query: "farming", resultCount: 5 });
      }).not.toThrow();

      // GA4 should still fire even if Vercel throws
      expect(mockGtag).toHaveBeenCalledWith("event", "explore_search", {
        query: "farming",
        resultCount: 5,
      });
    });

    it("handles all event types with correct property shapes", () => {
      // @ts-expect-error — minimal window mock
      globalThis.window = {};

      const events: {
        [K in keyof AnalyticsEvents]: AnalyticsEvents[K];
      } = {
        report_submitted: {
          type: "heavy-rain",
          severity: "severe",
          location: "harare",
        },
        report_upvoted: { reportId: "abc123", location: "bulawayo" },
        location_changed: {
          from: "harare",
          to: "bulawayo",
          method: "search",
        },
        location_saved: { slug: "mutare" },
        location_removed: { slug: "mutare" },
        activity_toggled: { activityId: "farming-maize", enabled: true },
        theme_changed: { theme: "system" },
        ai_summary_loaded: { location: "harare" },
        ai_chat_sent: { source: "shamwari", location: "harare" },
        explore_search: { query: "safari", resultCount: 3 },
        history_analysis: { location: "harare", days: 30 },
        geolocation_result: { status: "success", location: "harare" },
        map_layer_changed: { layer: "precipitation", location: "harare" },
        onboarding_completed: { method: "personalize" },
        modal_opened: { modal: "weather-report" },
      };

      for (const [name, props] of Object.entries(events)) {
        mockTrack.mockClear();
        trackEvent(
          name as keyof AnalyticsEvents,
          props as AnalyticsEvents[keyof AnalyticsEvents],
        );
        expect(mockTrack).toHaveBeenCalledWith(name, props);
      }
    });
  });
});
