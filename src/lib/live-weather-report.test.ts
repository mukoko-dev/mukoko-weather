import { describe, it, expect, vi } from "vitest";
import { reportLiveWeatherFailure } from "./live-weather-report";

describe("reportLiveWeatherFailure", () => {
  it("logs the route, status, kind, attempt and slug, and sends one analytics event", () => {
    const warn = vi.fn();
    const analytics = vi.fn();
    reportLiveWeatherFailure(
      "harare",
      { kind: "rate_limited", status: 429, retryAfterSeconds: 20 },
      2,
      { warn, analytics },
    );
    expect(warn).toHaveBeenCalledWith({
      source: "client-fetch",
      location: "harare",
      message: "live weather fetch failed: rate_limited",
      meta: {
        route: "weather",
        status: 429,
        kind: "rate_limited",
        attempt: 2,
        retryAfterSeconds: 20,
      },
    });
    expect(analytics).toHaveBeenCalledWith(
      "weather-api",
      "rate_limited",
      "harare",
    );
  });

  it("carries no coordinates and no URL, and the real console line coarsens a spot slug", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    reportLiveWeatherFailure(
      "west-paddock--ksy4dd7",
      { kind: "timeout", status: 0 },
      1,
    );
    const line = String(spy.mock.calls[0][0]);
    spy.mockRestore();
    expect(line).not.toMatch(/https?:/);
    expect(line).not.toMatch(/"lat"|"lon"|latitude|longitude|lat=|lon=/i);
    expect(line).not.toContain("west-paddock");
    expect(line).not.toContain("ksy4dd7");
    expect(line).toContain("spot--ksy4");
    expect(line).toContain('"status":0');
    expect(line).toContain('"route":"weather"');
  });

  it("never throws, whatever the sinks do", () => {
    expect(() =>
      reportLiveWeatherFailure("harare", { kind: "server", status: 503 }, 1, {
        warn: () => {
          throw new Error("console gone");
        },
        analytics: vi.fn(),
      }),
    ).not.toThrow();
  });
});
