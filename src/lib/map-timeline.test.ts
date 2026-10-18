import { afterEach, describe, it, expect, vi } from "vitest";
import { fetchPlaceOffset, frameInstantMs, frameStops } from "./map-timeline";
import {
  TIMELINE_STEPS,
  TIMELINE_STEP_HOURS,
  forecastTimelineFrames,
  modelTimelineFrames,
} from "./map-layers";

// Saturday 2026-10-10 07:40 UTC.
const NOW = new Date(Date.UTC(2026, 9, 10, 7, 40));
const HARARE = 2 * 3600;
const SINGAPORE = 8 * 3600;
const TORONTO = -4 * 3600;

describe("frameInstantMs — read back from the frame's own timestamp", () => {
  it("'now' is now; a timestamp is that instant", () => {
    expect(frameInstantMs({ timestamp: "now", label: "Now" }, NOW)).toBe(
      NOW.getTime(),
    );
    const f = forecastTimelineFrames(NOW)[3];
    expect(frameInstantMs(f, NOW)).toBe(Date.parse(f.timestamp));
  });
});

describe("frameInstantMs — a Now frame is now", () => {
  it("does not read an older grid step as the current clock", () => {
    const f = { timestamp: "2026-10-10T06:00Z", label: "Now" };
    expect(frameInstantMs(f, NOW)).toBe(NOW.getTime());
  });
});

const rain = (now: Date) => forecastTimelineFrames(now);

describe("frameStops — labels in the PLACE's wall clock", () => {
  it("has one stop per frame", () => {
    expect(frameStops(rain(NOW), NOW, HARARE, "Harare")).toHaveLength(
      TIMELINE_STEPS,
    );
  });

  it("labels the Now frame Now and later frames HH:MM at the place", () => {
    const stops = frameStops(rain(NOW), NOW, HARARE, "Harare");
    expect(stops[0].time).toBe("Now");
    expect(stops[0].clock).toBe("09:40");
    // 07:00 UTC + 3 h = 10:00 UTC = 12:00 Harare.
    expect(stops[1].time).toBe("12:00");
    expect(stops[1].hoursAhead).toBe(TIMELINE_STEP_HOURS);
  });

  it("gives the same instant different labels in different places", () => {
    expect(frameStops(rain(NOW), NOW, SINGAPORE, "Singapore")[1].time).toBe(
      "18:00",
    );
    expect(frameStops(rain(NOW), NOW, TORONTO, "Toronto")[1].time).toBe(
      "06:00",
    );
  });

  it("marks the first stop of each new local day with its weekday", () => {
    const stops = frameStops(rain(NOW), NOW, HARARE, "Harare");
    const starts = stops.filter((s) => s.dayStart);
    expect(starts.map((s) => s.day)).toEqual(["Sun", "Mon", "Tue"]);
    // Harare midnight Sunday = 22:00 UTC Saturday: step 5 (07 + 15 h).
    expect(starts[0].step).toBe(5);
    expect(starts[0].time).toBe("00:00");
    expect(stops[0].dayStart).toBe(false);
  });

  it("writes screen-reader text with the zone and how far ahead", () => {
    const stops = frameStops(rain(NOW), NOW, HARARE, "Harare");
    expect(stops[0].valueText).toBe("Now, Saturday 09:40 Harare time");
    expect(stops[1].valueText).toBe("Saturday 12:00 Harare time, in 3 hours");
    expect(stops[8].valueText).toBe("Sunday 09:00 Harare time, in 1 day");
    expect(stops[9].valueText).toBe("Sunday 12:00 Harare time, in 1 day 3 h");
  });

  it("says so when the offset is only an estimate", () => {
    const stops = frameStops(rain(NOW), NOW, 0, "Madrid", true);
    expect(stops[1].valueText).toBe(
      "Saturday 10:00 Madrid time (approximate), in 3 hours",
    );
  });

  it("works for model frames, which start at a real grid time", () => {
    const times = [
      "2026-10-10T06:00Z",
      "2026-10-10T09:00Z",
      "2026-10-10T12:00Z",
    ];
    const frames = modelTimelineFrames(times, NOW);
    const stops = frameStops(frames, NOW, HARARE, "Harare");
    // The 06:00Z step still contains 07:40Z, so it reads Now.
    expect(frames[0].label).toBe("Now");
    expect(stops[1].clock).toBe("11:00");
    expect(stops[1].hoursAhead).toBe(2);
  });
});

describe("fetchPlaceOffset — reads the API's offset, never throws", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function mockFetch(body: unknown, ok = true) {
    globalThis.fetch = vi.fn(async () => ({
      ok,
      json: async () => body,
    })) as unknown as typeof fetch;
  }

  it("returns the offset and whether the API estimated it", async () => {
    mockFetch({ utc_offset_seconds: 7200 });
    expect(await fetchPlaceOffset(-17.8, 31.0)).toEqual({
      offsetSeconds: 7200,
      estimated: false,
    });
    mockFetch({ utc_offset_seconds: 3600, utc_offset_estimated: true });
    expect(await fetchPlaceOffset(40.4, -3.7)).toEqual({
      offsetSeconds: 3600,
      estimated: true,
    });
  });

  it("calls only our own cached API", async () => {
    mockFetch({ utc_offset_seconds: 0 });
    await fetchPlaceOffset(1, 2);
    expect(String(vi.mocked(globalThis.fetch).mock.calls[0][0])).toBe(
      "https://weather-api.mukoko.com/v1/weather?lat=1&lon=2",
    );
  });

  it("returns null on errors, bad shapes and network failure", async () => {
    mockFetch({}, false);
    expect(await fetchPlaceOffset(0, 0)).toBeNull();
    mockFetch({ utc_offset_seconds: "x" });
    expect(await fetchPlaceOffset(0, 0)).toBeNull();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchPlaceOffset(0, 0)).toBeNull();
  });
});
