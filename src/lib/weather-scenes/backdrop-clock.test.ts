/**
 * The backdrop's dawn/dusk phase is read in the LOCATION's time, never the
 * viewer's: Harare (UTC+2) checked from Perth (UTC+8).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { backdropClock } from "./backdrop-clock";
import { skyPhase } from "./palette";

const HARARE = 7200;
const dailyNaive = {
  time: ["2026-10-08", "2026-10-09"],
  sunrise: ["2026-10-08T05:50", "2026-10-09T05:49"],
  sunset: ["2026-10-08T18:10", "2026-10-09T18:11"],
};
// Same day as zoned instants (Tomorrow.io shape).
const dailyZoned = {
  time: ["2026-10-08T00:00:00Z"],
  sunrise: ["2026-10-08T03:50:00Z"],
  sunset: ["2026-10-08T16:10:00Z"],
};

const phaseAt = (utc: string, daily = dailyNaive, isDay = true) => {
  const c = backdropClock(
    { utc_offset_seconds: HARARE, daily },
    null,
    new Date(utc),
  );
  return { c, phase: skyPhase(isDay, c.currentTime, c.sunrise, c.sunset) };
};

describe("backdropClock — Harare viewed from Perth", () => {
  const prevTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "Australia/Perth";
  });
  afterAll(() => {
    process.env.TZ = prevTz;
  });

  it("runs with the viewer in Perth (UTC+8)", () => {
    expect(new Date("2026-10-08T04:10:00Z").getHours()).toBe(12);
  });

  it("Harare 06:10 local is dawn", () => {
    const { c, phase } = phaseAt("2026-10-08T04:10:00Z");
    expect(c.currentTime).toBe("2026-10-08T06:10");
    expect(phase).toBe("dawn");
  });

  it("Harare 18:20 local is dusk", () => {
    const { c, phase } = phaseAt("2026-10-08T16:20:00Z");
    expect(c.currentTime).toBe("2026-10-08T18:20");
    expect(phase).toBe("dusk");
  });

  it("Harare midday is plain day (the viewer's evening doesn't leak in)", () => {
    // 10:00Z = 12:00 Harare = 18:00 Perth, right at a Perth-style dusk.
    expect(phaseAt("2026-10-08T10:00:00Z").phase).toBe("day");
  });

  it("normalises zoned provider sunrise/sunset to Harare wall time", () => {
    const dawn = phaseAt("2026-10-08T04:10:00Z", dailyZoned);
    expect(dawn.c.sunrise).toBe("2026-10-08T05:50");
    expect(dawn.phase).toBe("dawn");
    expect(phaseAt("2026-10-08T16:20:00Z", dailyZoned).phase).toBe("dusk");
  });

  it("uses Harare's clock even when the payload has no offset", () => {
    const place = { lon: 31.05, country: "ZW" };
    const at = (utc: string) => {
      const c = backdropClock({ daily: dailyZoned }, place, new Date(utc));
      return skyPhase(true, c.currentTime, c.sunrise, c.sunset);
    };
    expect(at("2026-10-08T04:10:00Z")).toBe("dawn");
    expect(at("2026-10-08T16:20:00Z")).toBe("dusk");
    expect(at("2026-10-08T10:00:00Z")).toBe("day");
  });

  it("picks today's sunrise at the location", () => {
    // 23:30Z on the 8th is 01:30 on the 9th in Harare.
    expect(phaseAt("2026-10-08T23:30:00Z", dailyNaive, false).c.sunrise).toBe(
      "2026-10-09T05:49",
    );
  });
});

describe("WeatherDashboard wiring", () => {
  const src = readFileSync(
    resolve(__dirname, "../../app/[location]/WeatherDashboard.tsx"),
    "utf-8",
  );

  it("passes the location clock to WeatherBackdrop", () => {
    expect(src).toContain("backdropClock(weather, location)");
    expect(src).toContain("currentTime={skyClock?.currentTime}");
    expect(src).toContain("sunrise={skyClock?.sunrise}");
    expect(src).toContain("sunset={skyClock?.sunset}");
  });
});
