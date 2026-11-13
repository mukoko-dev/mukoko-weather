/**
 * Real-visitor loading numbers (#551): what is reported, what is left out, and
 * that nothing identifying can ride along.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  GTAG_MAX_TRIES,
  GTAG_WAIT_MS,
  REPORTED_VITALS,
  routeOf,
  sendVital,
  toVitalEvent,
  type VitalWindow,
  type WebVitalEvent,
} from "./web-vitals";

const lcp = {
  name: "LCP",
  value: 2431.6,
  rating: "good",
  navigationType: "navigate",
};

describe("toVitalEvent", () => {
  it("reports the five metrics and no others", () => {
    expect([...REPORTED_VITALS]).toEqual(["FCP", "LCP", "INP", "CLS", "TTFB"]);
    for (const name of REPORTED_VITALS) {
      expect(toVitalEvent({ name, value: 100 }, "/")).not.toBeNull();
    }
    for (const name of ["Next.js-hydration", "Next.js-render", "FID", ""]) {
      expect(toVitalEvent({ name, value: 100 }, "/")).toBeNull();
    }
  });

  it("rounds milliseconds and sends CLS times 1000 as a whole number", () => {
    expect(toVitalEvent(lcp, "/")?.metric_value).toBe(2432);
    expect(
      toVitalEvent({ name: "CLS", value: 0.0043 }, "/")?.metric_value,
    ).toBe(4);
    expect(toVitalEvent({ name: "CLS", value: 0.25 }, "/")?.metric_value).toBe(
      250,
    );
  });

  it("drops a value that cannot be a timing", () => {
    for (const value of [NaN, Infinity, -1]) {
      expect(toVitalEvent({ name: "LCP", value }, "/")).toBeNull();
    }
  });

  it("keeps the rating, navigation type and connection to short fixed words", () => {
    const e = toVitalEvent(lcp, "/", "3g");
    expect(e).toMatchObject({
      metric_name: "LCP",
      metric_rating: "good",
      navigation_type: "navigate",
      connection: "3g",
    });
    const odd = toVitalEvent(
      {
        name: "LCP",
        value: 1,
        rating: "<script>",
        navigationType: "https://x.example/?id=7",
      },
      "/",
      "my-home-wifi",
    );
    expect(odd).toMatchObject({
      metric_rating: "unknown",
      navigation_type: "unknown",
      connection: "unknown",
    });
  });
});

describe("routeOf", () => {
  it("names the page type and never the place", () => {
    expect(routeOf("/")).toBe("home");
    expect(routeOf("/harare")).toBe("place");
    expect(routeOf("/harare/")).toBe("place");
    expect(routeOf("/about")).toBe("other");
    expect(routeOf("/profile")).toBe("other");
    expect(routeOf("/harare/forecast")).toBe("other");
  });

  it("carries no place name, spot or id in the event", () => {
    const spot = "/my-farm--kf8ybzq";
    const e = toVitalEvent(lcp, spot, "4g") as WebVitalEvent;
    expect(e.route).toBe("place");
    expect(JSON.stringify(e)).not.toMatch(/farm|kf8ybzq|harare/i);
    expect(Object.keys(e).sort()).toEqual([
      "connection",
      "metric_name",
      "metric_rating",
      "metric_value",
      "navigation_type",
      "route",
    ]);
  });
});

describe("sendVital", () => {
  const event = toVitalEvent(lcp, "/", "4g") as WebVitalEvent;

  it("sends at once when gtag is already there", () => {
    const gtag = vi.fn();
    const schedule = vi.fn();
    sendVital(event, { gtag } as VitalWindow, schedule);
    expect(gtag).toHaveBeenCalledExactlyOnceWith("event", "web_vitals", event);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("waits for gtag to load (first paint can beat it) and then sends", () => {
    const win: VitalWindow = {};
    const queue: Array<() => void> = [];
    const schedule = vi.fn((fn: () => void, ms: number) => {
      expect(ms).toBe(GTAG_WAIT_MS);
      queue.push(fn);
    });
    sendVital(event, win, schedule);
    queue.shift()?.();
    queue.shift()?.();
    expect(queue).toHaveLength(1);
    const gtag = vi.fn();
    win.gtag = gtag;
    queue.shift()?.();
    expect(gtag).toHaveBeenCalledExactlyOnceWith("event", "web_vitals", event);
    expect(queue).toHaveLength(0);
  });

  it("gives up quietly when gtag never loads (an ad blocker)", () => {
    const queue: Array<() => void> = [];
    const schedule = (fn: () => void) => {
      queue.push(fn);
    };
    sendVital(event, {}, schedule);
    let runs = 0;
    while (queue.length) {
      queue.shift()?.();
      runs++;
      expect(runs).toBeLessThanOrEqual(GTAG_MAX_TRIES + 1);
    }
    expect(runs).toBe(GTAG_MAX_TRIES);
  });

  it("never throws, even when gtag does", () => {
    const gtag = vi.fn(() => {
      throw new Error("blocked");
    });
    expect(() =>
      sendVital(event, { gtag } as VitalWindow, vi.fn()),
    ).not.toThrow();
  });
});

describe("the root layout", () => {
  const layout = readFileSync(resolve(__dirname, "../app/layout.tsx"), "utf-8");

  it("mounts the reporter once, next to the page-view tracker", () => {
    expect(layout).toContain(
      'import { WebVitals } from "@/components/analytics/WebVitals";',
    );
    expect(layout.match(/<WebVitals \/>/g)).toHaveLength(1);
  });
});
