import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { trackEvent, type AnalyticsEvents } from "./analytics";

describe("analytics", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let originalWindow: any;

  beforeEach(() => {
    originalWindow = globalThis.window;
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

      expect(() =>
        trackEvent("report_submitted", {
          type: "heavy-rain",
          severity: "moderate",
          location: "harare",
        }),
      ).not.toThrow();
    });

    it("fires GA4 gtag() with correct event name and properties", () => {
      const mockGtag = vi.fn();
      // @ts-expect-error — minimal window mock with gtag
      globalThis.window = { gtag: mockGtag };

      trackEvent("theme_changed", { theme: "dark" });

      expect(mockGtag).toHaveBeenCalledExactlyOnceWith(
        "event",
        "theme_changed",
        { theme: "dark" },
      );
    });

    it("sends one GA4 event per call and nothing else", () => {
      const mockGtag = vi.fn();
      // @ts-expect-error — minimal window mock with gtag
      globalThis.window = { gtag: mockGtag };

      trackEvent("activity_toggled", {
        activityId: "farming-maize",
        enabled: true,
      });

      expect(mockGtag).toHaveBeenCalledTimes(1);
      expect(mockGtag).toHaveBeenCalledWith("event", "activity_toggled", {
        activityId: "farming-maize",
        enabled: true,
      });
    });

    it("silently continues if gtag is not defined (an ad blocker)", () => {
      // @ts-expect-error — window without gtag
      globalThis.window = {};

      expect(() => {
        trackEvent("modal_opened", { modal: "my-weather" });
      }).not.toThrow();
    });

    it("never lets a throwing gtag break the app", () => {
      const mockGtag = vi.fn(() => {
        throw new Error("gtag blocked");
      });
      // @ts-expect-error — minimal window mock with a failing gtag
      globalThis.window = { gtag: mockGtag };

      expect(() => {
        trackEvent("explore_search", { query: "farming", resultCount: 5 });
      }).not.toThrow();
      expect(mockGtag).toHaveBeenCalledTimes(1);
    });

    it("handles all event types with correct property shapes", () => {
      const mockGtag = vi.fn();
      // @ts-expect-error — minimal window mock with gtag
      globalThis.window = { gtag: mockGtag };

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
        alert_kind_toggled: { kind: "frost", enabled: true },
        alert_report_started: { kind: "flooding" },
        modal_opened: { modal: "weather-report" },
      };

      for (const [name, props] of Object.entries(events)) {
        mockGtag.mockClear();
        trackEvent(
          name as keyof AnalyticsEvents,
          props as AnalyticsEvents[keyof AnalyticsEvents],
        );
        expect(mockGtag).toHaveBeenCalledWith("event", name, props);
      }
    });
  });
});
