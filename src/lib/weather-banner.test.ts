import { describe, it, expect } from "vitest";
import { weatherBanner, type BannerInput } from "./weather-banner";
import type { LiveFetchState } from "./live-fetch";

const state = (over: Partial<LiveFetchState> = {}): LiveFetchState => ({
  status: "idle",
  failure: null,
  attempt: 0,
  retryInMs: null,
  ...over,
});

const input = (over: Partial<BannerInput> = {}): BannerInput => ({
  fallback: false,
  stale: false,
  live: state(),
  ...over,
});

describe("weatherBanner: when it shows", () => {
  it("never shows for live, fresh data", () => {
    expect(weatherBanner(input()).show).toBe(false);
    expect(
      weatherBanner(input({ live: state({ status: "failed" }) })).show,
    ).toBe(false);
  });

  it("shows when the data on screen is the seasonal estimate", () => {
    const b = weatherBanner(input({ fallback: true }));
    expect(b.show).toBe(true);
    expect(b.variant).toBe("fallback");
    expect(b.title).toBe("Live weather data temporarily unavailable");
  });

  it("clears the moment the data on screen is no longer a fallback", () => {
    // Same live state ("ok") that follows a successful fetch:
    expect(
      weatherBanner(input({ fallback: false, live: state({ status: "ok" }) }))
        .show,
    ).toBe(false);
  });

  it("is not tied to a missing baseline: a live seed with no client baseline shows nothing", () => {
    expect(
      weatherBanner(input({ fallback: false, live: state({ status: "idle" }) }))
        .show,
    ).toBe(false);
  });

  it("shows for a stale device copy only once a refresh has not worked", () => {
    expect(weatherBanner(input({ stale: true })).show).toBe(false);
    expect(
      weatherBanner(input({ stale: true, live: state({ status: "loading" }) }))
        .show,
    ).toBe(false);
    for (const status of ["retrying", "failed"] as const) {
      const b = weatherBanner(
        input({
          stale: true,
          live: state({
            status,
            failure: { kind: "server", status: 503 },
          }),
        }),
      );
      expect(b.show).toBe(true);
      expect(b.variant).toBe("stale");
    }
  });
});

describe("weatherBanner: the reason, in plain words", () => {
  const reason = (
    failure: LiveFetchState["failure"],
    status: LiveFetchState["status"],
    fallback = true,
  ) =>
    weatherBanner(
      input({ fallback, stale: !fallback, live: state({ status, failure }) }),
    ).reason;

  it("rate limited", () => {
    const f = { kind: "rate_limited", status: 429 } as const;
    expect(reason(f, "retrying")).toBe("Busy right now, retrying");
    expect(reason(f, "failed")).toBe("Busy right now. Try again in a moment.");
  });

  it("offline", () => {
    const f = { kind: "offline", status: 0 } as const;
    expect(reason(f, "failed", false)).toBe(
      "You're offline: showing the last forecast",
    );
    expect(reason(f, "failed", true)).toBe(
      "You're offline: showing seasonal estimates",
    );
  });

  it("timeout and server errors", () => {
    for (const kind of ["timeout", "server"] as const) {
      const f = { kind, status: 0 } as const;
      expect(reason(f, "retrying")).toBe(
        "The forecast service is slow, retrying",
      );
      expect(reason(f, "failed")).toBe(
        "The forecast service is slow. Try again in a moment.",
      );
    }
  });

  it("while the first fetch is out, it says it is checking; an invalid answer says nothing", () => {
    expect(reason(null, "loading")).toBe("Checking for live data");
    expect(reason({ kind: "invalid", status: 400 }, "failed")).toBeNull();
    expect(reason(null, "idle")).toBeNull();
  });

  it("a retry is offered unless one is running", () => {
    expect(
      weatherBanner(
        input({ fallback: true, live: state({ status: "loading" }) }),
      ).canRetry,
    ).toBe(false);
    expect(
      weatherBanner(
        input({ fallback: true, live: state({ status: "failed" }) }),
      ).canRetry,
    ).toBe(true);
    expect(weatherBanner(input({ fallback: true })).canRetry).toBe(true);
  });

  it("a stored forecast the Worker served stale is shown and said so, with no device copy involved", () => {
    const b = weatherBanner(input({ serverStale: true }));
    expect(b.show).toBe(true);
    expect(b.variant).toBe("stale");
    expect(b.message).toBe(
      "Showing the last forecast we received for this location.",
    );
    // A live answer shows nothing.
    expect(weatherBanner(input({ serverStale: false })).show).toBe(false);
  });
});
