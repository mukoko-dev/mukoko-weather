import { describe, expect, it } from "vitest";
import {
  ARCHIVE_SOURCES,
  CLAMPED_NOTE,
  DEGRADED_NOTE,
  HISTORY_MAX_DAYS,
  HISTORY_RANGES,
  RETRY_UP_TO_DAYS,
  SAVING_NOTE,
  STILL_WORKING_AFTER_MS,
  STILL_WORKING_NOTE,
  archiveNote,
  historyFetchOptions,
  historyNotices,
  historyQuery,
  historySource,
  isArchiveSource,
  lagNote,
  readHistoryAnswer,
} from "./history-api";

describe("ranges", () => {
  it("offers 2 and 5 years, all inside what the Worker accepts", () => {
    const days = HISTORY_RANGES.map((r) => r.value);
    expect(days).toContain(730);
    expect(days).toContain(1825);
    expect(Math.max(...days)).toBeLessThanOrEqual(HISTORY_MAX_DAYS);
    expect(new Set(days).size).toBe(days.length);
    expect([...days].sort((a, b) => a - b)).toEqual(days);
    expect(HISTORY_RANGES.find((r) => r.value === 1825)?.label).toBe("5 years");
  });
});

describe("historyQuery", () => {
  it("asks for the last N days by slug", () => {
    expect(historyQuery({ slug: "harare", days: 30 })).toBe(
      "location=harare&days=30",
    );
  });
  it("escapes the slug and adds rounded coordinates", () => {
    const q = new URLSearchParams(
      historyQuery({
        slug: "london--gcpvj0e",
        lat: 51.507221,
        lon: -0.127612,
        days: 365,
      }),
    );
    expect(q.get("location")).toBe("london--gcpvj0e");
    expect(q.get("lat")).toBe("51.507");
    expect(q.get("lon")).toBe("-0.128");
    expect(q.get("days")).toBe("365");
  });
  it("lets start and end win over days", () => {
    const q = new URLSearchParams(
      historyQuery({
        slug: "tokyo-jp",
        days: 30,
        start: "2020-01-01",
        end: "2020-12-31",
      }),
    );
    expect(q.get("start")).toBe("2020-01-01");
    expect(q.get("end")).toBe("2020-12-31");
    expect(q.has("days")).toBe(false);
  });
  it("never asks for more than the Worker allows", () => {
    expect(historyQuery({ slug: "a", days: 99999 })).toContain(
      `days=${HISTORY_MAX_DAYS}`,
    );
    expect(historyQuery({ slug: "a", days: 0 })).toContain("days=1");
  });
  it("omits half a coordinate pair", () => {
    expect(historyQuery({ slug: "a", lat: 1 })).not.toContain("lat=");
  });
});

describe("historyFetchOptions", () => {
  it("waits longer than the Worker's 8 s default, more for long ranges", () => {
    expect(historyFetchOptions(7).timeoutMs).toBeGreaterThan(8_000);
    expect(historyFetchOptions(30).timeoutMs).toBeGreaterThanOrEqual(20_000);
    expect(historyFetchOptions(365).timeoutMs).toBeGreaterThanOrEqual(30_000);
    expect(historyFetchOptions(730).timeoutMs).toBeGreaterThanOrEqual(40_000);
    expect(historyFetchOptions(1825).timeoutMs).toBeGreaterThanOrEqual(40_000);
  });
  it("retries only a short range (the Worker keeps filling after a give-up)", () => {
    expect(historyFetchOptions(7).retries).toBe(1);
    expect(historyFetchOptions(RETRY_UP_TO_DAYS).retries).toBe(1);
    expect(historyFetchOptions(RETRY_UP_TO_DAYS + 1).retries).toBe(0);
    expect(historyFetchOptions(90).retries).toBe(0);
    expect(historyFetchOptions(365).retries).toBe(0);
    expect(historyFetchOptions(1825).retries).toBe(0);
  });
  it("never makes a view wait longer than its single timeout past a month", () => {
    for (const r of HISTORY_RANGES) {
      const { timeoutMs, retries } = historyFetchOptions(r.value);
      const worst = timeoutMs * (retries + 1);
      // 30 days: two 20 s attempts at worst; a year: one 30 s attempt.
      expect(worst).toBeLessThanOrEqual(r.value <= 31 ? 40_000 : 45_000);
    }
  });
  it("says it is still working well before the longest wait ends", () => {
    expect(STILL_WORKING_AFTER_MS).toBeLessThanOrEqual(10_000);
    expect(STILL_WORKING_AFTER_MS).toBeLessThan(
      historyFetchOptions(365).timeoutMs,
    );
    expect(STILL_WORKING_NOTE).toMatch(/still working/i);
  });
  it("covers every range the page offers", () => {
    for (const r of HISTORY_RANGES) {
      expect(historyFetchOptions(r.value).timeoutMs).toBeGreaterThan(8_000);
    }
  });
});

describe("sources", () => {
  it("knows the archive providers and treats anything else as recorded", () => {
    expect(ARCHIVE_SOURCES).toEqual(["nasa-power", "open-meteo-archive"]);
    expect(historySource("nasa-power")).toBe("nasa-power");
    expect(historySource("open-meteo-archive")).toBe("open-meteo-archive");
    expect(historySource("recorded")).toBe("recorded");
    expect(historySource(undefined)).toBe("recorded");
    expect(historySource("something-else")).toBe("recorded");
    expect(isArchiveSource("nasa-power")).toBe(true);
    expect(isArchiveSource("recorded")).toBe(false);
  });
});

describe("readHistoryAnswer", () => {
  it("reads the envelope the Worker sends", () => {
    const a = readHistoryAnswer({
      data: [{ date: "2026-10-28" }],
      sources: [
        {
          id: "nasa-power",
          name: "NASA POWER",
          attribution: "Data obtained from NASA",
          url: "https://power.larc.nasa.gov",
          licence: "NASA open data",
          licenceUrl: "https://example.org/policy",
        },
        { id: "broken" },
        null,
      ],
      backfilled: 3,
      clamped: true,
      missing: 2,
      saving: true,
      degraded: true,
    });
    expect(a.data).toHaveLength(1);
    expect(a.sources).toHaveLength(1);
    expect(a.sources[0]!.licenceUrl).toBe("https://example.org/policy");
    expect(a).toMatchObject({
      backfilled: 3,
      clamped: true,
      missing: 2,
      saving: true,
      degraded: true,
    });
  });
  it("tolerates an older body that has only data", () => {
    expect(readHistoryAnswer({ data: [] })).toEqual({
      data: [],
      sources: [],
      backfilled: 0,
      clamped: false,
      missing: 0,
      saving: false,
      degraded: false,
    });
    expect(readHistoryAnswer(null).data).toEqual([]);
    expect(readHistoryAnswer("nope").sources).toEqual([]);
  });
});

describe("notes", () => {
  it("names the archive that supplied the days", () => {
    expect(archiveNote([{ source: "recorded" }])).toBeNull();
    expect(
      archiveNote([{ source: "recorded" }, { source: "nasa-power" }]),
    ).toBe(
      "1 of 2 days come from NASA POWER (reanalysis, daily averages). The rest were recorded live.",
    );
    expect(
      archiveNote([{ source: "open-meteo-archive" }, { source: "recorded" }]),
    ).toContain("the Open-Meteo ERA5 archive");
    expect(
      archiveNote([{ source: "open-meteo-archive" }, { source: "nasa-power" }]),
    ).toContain("NASA POWER and the Open-Meteo ERA5 archive");
  });
  it("explains a clamp and a lag", () => {
    expect(CLAMPED_NOTE).toContain("most recent year");
    expect(lagNote(0)).toBeNull();
    expect(lagNote(1)).toBe(
      "One day has no data yet: archives run a few days behind.",
    );
    expect(lagNote(3)).toBe(
      "3 days have no data yet: archives run a few days behind.",
    );
  });
});

describe("historyNotices", () => {
  const base = { clamped: false, degraded: false, missing: 0, saving: false };
  it("blames the archive lag only when the lag is the cause", () => {
    expect(historyNotices({ ...base, missing: 2 })).toEqual([lagNote(2)]);
    // A degraded answer is missing days for another reason: no lag note.
    expect(historyNotices({ ...base, missing: 40, degraded: true })).toEqual(
      [],
    );
    expect(lagNote(40)).toMatch(/archives run a few days behind/);
    expect(DEGRADED_NOTE).not.toMatch(/archive/i);
  });
  it("adds the clamp and the quiet saving note", () => {
    expect(historyNotices({ ...base, clamped: true })).toEqual([CLAMPED_NOTE]);
    expect(historyNotices({ ...base, saving: true })).toEqual([SAVING_NOTE]);
    expect(
      historyNotices({ ...base, clamped: true, missing: 1, saving: true }),
    ).toEqual([CLAMPED_NOTE, lagNote(1), SAVING_NOTE]);
    // Nothing to say about a complete, stored answer.
    expect(historyNotices(base)).toEqual([]);
  });
  it("keeps the clamp note on a degraded answer, nothing else", () => {
    expect(
      historyNotices({ ...base, clamped: true, degraded: true, saving: true }),
    ).toEqual([CLAMPED_NOTE]);
  });
  it("offers a retry notice that says what to do", () => {
    expect(DEGRADED_NOTE).toMatch(/try again/i);
  });
});
