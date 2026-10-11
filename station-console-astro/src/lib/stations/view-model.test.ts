import { describe, expect, it } from "vitest";
import { INGEST_PATH } from "../config";
import {
  describeLastReading,
  describeReadingResult,
  formatMetrics,
  mergeStations,
  metricLabel,
  setupInstructions,
} from "./view-model";

const server = [
  {
    stationId: "mws-00000001",
    name: "Owned",
    stationType: "digital" as const,
    status: "active",
    lastObservationAt: null,
  },
];
const local = [
  {
    stationId: "mws-00000001",
    key: "saved",
    name: "Owned (old name)",
    stationType: "digital" as const,
  },
  {
    stationId: "mws-00000002",
    key: "legacy",
    name: "Legacy",
    stationType: "manual" as const,
  },
];

describe("mergeStations", () => {
  it("lists server stations first, attaches saved keys, and keeps key-only ones", () => {
    expect(mergeStations(server, local)).toEqual([
      {
        stationId: "mws-00000001",
        name: "Owned",
        stationType: "digital",
        access: "owner",
        key: "saved",
      },
      {
        stationId: "mws-00000002",
        name: "Legacy",
        stationType: "manual",
        access: "key",
        key: "legacy",
      },
    ]);
  });
  it("works with an empty server list or an empty browser", () => {
    expect(mergeStations([], local).every((s) => s.access === "key")).toBe(
      true,
    );
    expect(mergeStations(server, [])[0]).toMatchObject({
      access: "owner",
      key: undefined,
    });
  });
});

describe("setupInstructions", () => {
  it("uses the configured host and the fixed ingest path hardware already uses", () => {
    expect(INGEST_PATH).toBe("/api/py/stations/ingest");
    const i = setupInstructions("weather.mukoko.com", "mws-0a0a0a0a");
    expect(i.wunderground).toContain(
      "server weather.mukoko.com, path /api/py/stations/ingest",
    );
    expect(i.wunderground).toContain("ID = mws-0a0a0a0a");
    expect(i.ecowitt).toContain("PASSKEY = mws-0a0a0a0a:<your ingest key>");
  });
  it("never embeds the key", () => {
    expect(
      JSON.stringify(setupInstructions("h.test", "mws-0a0a0a0a")),
    ).not.toMatch(/secret/);
  });
});

describe("formatting", () => {
  it("humanises metric names", () => {
    expect(metricLabel("airTemperatureCelsius")).toBe(
      "air temperature celsius",
    );
    expect(formatMetrics({ windSpeedKph: 4, uvIndex: 2 })).toBe(
      "wind speed kph: 4 · uv index: 2",
    );
    expect(formatMetrics(null)).toBe("");
  });
  it("describes the last reading", () => {
    expect(describeLastReading(null)).toBe("No readings yet");
    expect(describeLastReading("garbage")).toBe("No readings yet");
    expect(describeLastReading("2026-10-11T08:00:00Z", "en-GB")).toMatch(
      /^Last reading /,
    );
  });
  it("describes QC outcomes", () => {
    expect(describeReadingResult({ accepted: 3, qcStatus: "validated" })).toBe(
      "Saved. 3 measurement(s) accepted",
    );
    expect(describeReadingResult({ accepted: 0, qcStatus: "rejected" })).toBe(
      "Rejected by quality checks",
    );
  });
});
