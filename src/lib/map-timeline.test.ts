import { describe, it, expect } from "vitest";
import { stopInstantMs, timelineStops } from "./map-timeline";
import {
  TIMELINE_STEPS,
  TIMELINE_STEP_HOURS,
  timelineTimestamp,
} from "./map-layers";

// Saturday 2026-10-10 07:40 UTC.
const NOW = new Date(Date.UTC(2026, 9, 10, 7, 40));
const HARARE = 2 * 3600;
const SINGAPORE = 8 * 3600;
const TORONTO = -4 * 3600;

describe("stopInstantMs — matches the tile timestamps", () => {
  it("step 0 is now; step n is the floored UTC hour + n × 3 h", () => {
    expect(stopInstantMs(0, NOW)).toBe(NOW.getTime());
    for (const step of [1, 2, 8, TIMELINE_STEPS - 1]) {
      const iso = timelineTimestamp(step, NOW);
      expect(new Date(iso).getTime()).toBe(stopInstantMs(step, NOW));
    }
  });
});

describe("timelineStops — labels in the PLACE's wall clock", () => {
  it("has one stop per timeline step", () => {
    expect(timelineStops(NOW, HARARE, "Harare")).toHaveLength(TIMELINE_STEPS);
  });

  it("labels step 0 Now and later steps HH:MM at the place", () => {
    const stops = timelineStops(NOW, HARARE, "Harare");
    expect(stops[0].time).toBe("Now");
    expect(stops[0].clock).toBe("09:40");
    // 07:00 UTC + 3 h = 10:00 UTC = 12:00 Harare.
    expect(stops[1].time).toBe("12:00");
    expect(stops[1].hoursAhead).toBe(TIMELINE_STEP_HOURS);
  });

  it("gives the same instant different labels in different places", () => {
    expect(timelineStops(NOW, SINGAPORE, "Singapore")[1].time).toBe("18:00");
    expect(timelineStops(NOW, TORONTO, "Toronto")[1].time).toBe("06:00");
  });

  it("marks the first stop of each new local day with its weekday", () => {
    const stops = timelineStops(NOW, HARARE, "Harare");
    const starts = stops.filter((s) => s.dayStart);
    expect(starts.map((s) => s.day)).toEqual(["Sun", "Mon", "Tue"]);
    // Harare midnight Sunday = 22:00 UTC Saturday: step 5 (07 + 15 h).
    expect(starts[0].step).toBe(5);
    expect(starts[0].time).toBe("00:00");
    expect(stops[0].dayStart).toBe(false);
  });

  it("writes screen-reader text with the zone and how far ahead", () => {
    const stops = timelineStops(NOW, HARARE, "Harare");
    expect(stops[0].valueText).toBe("Now, Saturday 09:40 Harare time");
    expect(stops[1].valueText).toBe("Saturday 12:00 Harare time, in 3 hours");
    expect(stops[8].valueText).toBe("Sunday 09:00 Harare time, in 1 day");
    expect(stops[9].valueText).toBe("Sunday 12:00 Harare time, in 1 day 3 h");
  });
});
