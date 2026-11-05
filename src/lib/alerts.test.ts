import { describe, expect, it } from "vitest";
import {
  ADVISORY_SOURCE,
  ALERT_KINDS,
  ALERT_KIND_ABOUT,
  ALERT_KIND_LABELS,
  ALERT_THRESHOLDS,
  COMMUNITY_SOURCE,
  COMMUNITY_SOURCE_MATCHED,
  agoLabel,
  collectAlerts,
  communityAlerts,
  emptyAlertsCopy,
  forecastAsOf,
  forecastUsable,
  forecastWindow,
  placeAlerts,
  sortAlerts,
  type Alert,
  type AlertPlace,
  type CommunityReportLike,
} from "./alerts";
import { RAIN_SCALE } from "./weather-scales";
import type { WeatherData } from "./weather";

/**
 * Harare is UTC+2 (7200 s). The forecast times are naive local strings, as
 * Open-Meteo sends them: index 0 is 2026-07-10T00:00 at the place, so the
 * local hour of day is `index % 24`.
 */
const HARARE = 7200;
const NOW = new Date("2026-07-10T14:05:00Z"); // 16:05 in Harare
const HOUR = 3_600_000;

function iso(i: number): string {
  const d = new Date(Date.UTC(2026, 6, 10, 0, 0) + i * HOUR);
  return d.toISOString().slice(0, 16);
}

interface Make {
  offset?: number;
  hours?: number;
  temp?: (i: number) => number;
  code?: (i: number) => number;
  precip?: (i: number) => number | null;
  thunderProbability?: number;
}

function makeWeather(o: Make = {}): WeatherData {
  const n = o.hours ?? 24 * 8;
  const idx = Array.from({ length: n }, (_, i) => i);
  return {
    utc_offset_seconds: o.offset ?? HARARE,
    hourly: {
      time: idx.map(iso),
      temperature_2m: idx.map(o.temp ?? (() => 15)),
      weather_code: idx.map(o.code ?? (() => 0)),
      precipitation: idx.map((i) => (o.precip ? o.precip(i) : 0)),
    },
    insights:
      o.thunderProbability === undefined
        ? undefined
        : { thunderstormProbability: o.thunderProbability },
  } as unknown as WeatherData;
}

function place(
  weather: WeatherData | null,
  extra: Partial<AlertPlace> = {},
): AlertPlace {
  return {
    slug: "harare",
    name: "Harare",
    weather,
    fetchedAt: weather ? NOW.getTime() - 10 * 60_000 : null,
    reports: null,
    ...extra,
  };
}

const kinds = (alerts: Alert[]) => alerts.map((a) => a.kind);

describe("kinds and thresholds", () => {
  it("has the four kinds in the order the settings list them, with their labels", () => {
    expect([...ALERT_KINDS]).toEqual([
      "frost",
      "lightning",
      "wildfire",
      "flooding",
    ]);
    expect(ALERT_KIND_LABELS).toEqual({
      frost: "Frost",
      lightning: "Lightning",
      wildfire: "Wildfire",
      flooding: "Flooding",
    });
    for (const kind of ALERT_KINDS) {
      expect(ALERT_KIND_ABOUT[kind].length).toBeGreaterThan(10);
    }
  });

  it("reads the flooding rate bands from the radar legend, so the map and the list agree", () => {
    const from = (name: string) =>
      RAIN_SCALE.bands.find((b) => b.name === name)?.from;
    expect(ALERT_THRESHOLDS.flooding.peakMmPerHour.moderate).toBe(
      from("Very heavy"),
    );
    expect(ALERT_THRESHOLDS.flooding.peakMmPerHour.high).toBe(from("Intense"));
    expect(ALERT_THRESHOLDS.flooding.peakMmPerHour).toEqual({
      moderate: 24,
      high: 47,
    });
  });

  it("orders every threshold pair moderate below high", () => {
    const t = ALERT_THRESHOLDS;
    expect(t.lightning.probabilityPct.moderate).toBeLessThan(
      t.lightning.probabilityPct.high,
    );
    expect(t.lightning.thunderHours.moderate).toBeLessThan(
      t.lightning.thunderHours.high,
    );
    expect(t.flooding.totalMm.moderate).toBeLessThan(t.flooding.totalMm.high);
    expect(t.flooding.peakMmPerHour.moderate).toBeLessThan(
      t.flooding.peakMmPerHour.high,
    );
    expect(t.windowHours).toBe(24);
  });
});

describe("small helpers", () => {
  it("agoLabel is zone free", () => {
    const now = 10_000_000_000;
    expect(agoLabel(now - 20_000, now)).toBe("just now");
    expect(agoLabel(now - 25 * 60_000, now)).toBe("25 min ago");
    expect(agoLabel(now - 3 * HOUR, now)).toBe("3 h ago");
    expect(agoLabel(now - 26 * HOUR, now)).toBe("1 day ago");
    expect(agoLabel(now - 50 * HOUR, now)).toBe("2 days ago");
    expect(agoLabel(Number.NaN, now)).toBe("just now");
  });

  it("forecastAsOf reads the fetch time in the PLACE's time zone", () => {
    const fetched = Date.parse("2026-07-10T13:50:00Z");
    expect(forecastAsOf(fetched, 7200, "Harare")).toBe(
      "Forecast as of 15:50 (Harare time)",
    );
    expect(forecastAsOf(fetched, -18000, "Lima")).toBe(
      "Forecast as of 08:50 (Lima time)",
    );
    expect(forecastAsOf(fetched, 28800, "  ")).toContain("(the place time)");
  });

  it("forecastWindow starts at the place's current hour and spans 24 hours", () => {
    const times = makeWeather().hourly.time;
    expect(forecastWindow(times, HARARE, NOW)).toEqual({ from: 16, to: 40 });
    // The same instant is 09:05 at UTC-5: a different slot.
    expect(forecastWindow(times, -18000, NOW)).toEqual({ from: 9, to: 33 });
  });

  it("forecastWindow is null for a series that no longer reaches now, and clips at the end", () => {
    expect(
      forecastWindow(makeWeather({ hours: 10 }).hourly.time, HARARE, NOW),
    ).toBeNull();
    expect(forecastWindow(undefined, HARARE, NOW)).toBeNull();
    expect(forecastWindow([], HARARE, NOW)).toBeNull();
    expect(
      forecastWindow(makeWeather({ hours: 30 }).hourly.time, HARARE, NOW),
    ).toEqual({
      from: 16,
      to: 30,
    });
  });

  it("forecastUsable refuses a forecast older than six hours, or without a fetch time", () => {
    const w = makeWeather();
    expect(forecastUsable(place(w), NOW)).toBe(true);
    expect(
      forecastUsable(place(w, { fetchedAt: NOW.getTime() - 7 * HOUR }), NOW),
    ).toBe(false);
    expect(forecastUsable(place(w, { fetchedAt: null }), NOW)).toBe(false);
    expect(forecastUsable(place(null), NOW)).toBe(false);
  });
});

describe("frost", () => {
  const frostNight = (low: number) =>
    makeWeather({
      // 22:00 tonight to 06:00 tomorrow
      temp: (i) => (i >= 22 && i <= 30 ? low : 15),
    });

  it("raises an advisory for tonight with the place's own hours", () => {
    const [alert] = placeAlerts(place(frostNight(1)), NOW);
    expect(alert).toMatchObject({
      id: "harare:frost:advisory",
      kind: "frost",
      level: "advisory",
      severity: "high",
      headline: "Frost advisory",
      when: "Tonight, between 22:00 and 06:00",
      source: ADVISORY_SOURCE,
      placeSlug: "harare",
      placeName: "Harare",
    });
    expect(alert.message).toBe(
      "Frost is likely, with a low near 1°C. Cover seedlings and sensitive plants.",
    );
    expect(alert.asOf).toBe("Forecast as of 15:55 (Harare time)");
  });

  it("uses the app's frost rule: 3°C counts, 3.1°C does not, and a cold afternoon is not frost", () => {
    expect(kinds(placeAlerts(place(frostNight(3)), NOW))).toEqual(["frost"]);
    expect(placeAlerts(place(frostNight(3.1)), NOW)).toEqual([]);
    const coldDay = makeWeather({ temp: (i) => (i >= 28 && i <= 36 ? 0 : 15) });
    // 04:00 to 12:00 tomorrow: the night hours (to 08:00) are frost hours...
    expect(placeAlerts(place(coldDay), NOW)[0]?.when).toBe(
      "Early tomorrow morning, between 04:00 and 08:00",
    );
    // ...but a cold midday alone is not.
    const coldNoon = makeWeather({
      temp: (i) => (i >= 34 && i <= 36 ? 0 : 15),
    });
    expect(placeAlerts(place(coldNoon), NOW)).toEqual([]);
  });

  it("grades by the coldest hour: moderate is possible, high and severe are likely", () => {
    const moderate = placeAlerts(place(frostNight(2.6)), NOW)[0];
    expect(moderate.severity).toBe("moderate");
    expect(moderate.message).toContain("Frost is possible");
    expect(placeAlerts(place(frostNight(2)), NOW)[0].severity).toBe("high");
    const severe = placeAlerts(place(frostNight(-1)), NOW)[0];
    expect(severe.severity).toBe("severe");
    expect(severe.message).toContain("low near -1°C");
  });

  it("looks only 24 hours ahead", () => {
    // frost two nights from now
    const later = makeWeather({ temp: (i) => (i >= 46 && i <= 54 ? 0 : 15) });
    expect(placeAlerts(place(later), NOW)).toEqual([]);
  });

  it("names the night that is happening when it is already under way", () => {
    const now = new Date("2026-07-11T00:30:00Z"); // 02:30 in Harare
    const w = makeWeather({ temp: (i) => (i >= 26 && i <= 30 ? 1 : 15) });
    const [alert] = placeAlerts(
      place(w, { fetchedAt: now.getTime() - 5 * 60_000 }),
      now,
    );
    expect(alert.when).toBe("Early this morning, between 02:00 and 06:00");
  });

  it("reports a night whole even when it runs past the 24 hour window", () => {
    // At 23:05 the window ends at 23:00 tomorrow; tomorrow night starts at
    // 22:00 inside it and runs to 06:00, past its end.
    const now = new Date("2026-07-10T21:05:00Z"); // 23:05 in Harare
    const w = makeWeather({ temp: (i) => (i >= 46 && i <= 54 ? 0 : 15) });
    const [alert] = placeAlerts(
      place(w, { fetchedAt: now.getTime() - 60_000 }),
      now,
    );
    expect(alert.when).toBe("Tomorrow night, between 22:00 and 06:00");
  });

  it("reports the first night when two fall in the window", () => {
    const now = new Date("2026-07-11T03:00:00Z"); // 05:00 in Harare
    const w = makeWeather({
      temp: (i) => (i === 29 || i === 30 || (i >= 46 && i <= 52) ? 0 : 15),
    });
    const [alert] = placeAlerts(
      place(w, { fetchedAt: now.getTime() - 60_000 }),
      now,
    );
    expect(alert.when).toBe("Early this morning, between 05:00 and 06:00");
  });

  it("reads the night hours at the place, not at the viewer", () => {
    // 22:00 to 06:00 at UTC-5; the same instant is 09:05 there, so the window
    // starts at index 9 and tonight is 13 hours away.
    const w = makeWeather({
      offset: -18000,
      temp: (i) => (i >= 22 && i <= 30 ? 0 : 15),
    });
    const [alert] = placeAlerts(place(w, { name: "Lima", slug: "lima" }), NOW);
    expect(alert.when).toBe("Tonight, between 22:00 and 06:00");
    expect(alert.asOf).toBe("Forecast as of 08:55 (Lima time)");
  });

  it("ignores missing temperatures", () => {
    const w = makeWeather();
    (w.hourly.temperature_2m as unknown as (number | null)[])[24] = null;
    expect(placeAlerts(place(w), NOW)).toEqual([]);
  });
});

describe("lightning", () => {
  it("raises a moderate advisory for one thunderstorm hour, with its hour", () => {
    const w = makeWeather({ code: (i) => (i === 17 ? 95 : 0) });
    const [alert] = placeAlerts(place(w), NOW);
    expect(alert).toMatchObject({
      kind: "lightning",
      severity: "moderate",
      headline: "Lightning advisory",
      when: "Today around 17:00",
      source: ADVISORY_SOURCE,
    });
    expect(alert.message).toBe(
      "Thunderstorms are possible. If you hear thunder, go indoors.",
    );
  });

  it("raises a high advisory for three thunderstorm hours, as a range", () => {
    const w = makeWeather({ code: (i) => (i >= 17 && i <= 19 ? 95 : 0) });
    const [alert] = placeAlerts(place(w), NOW);
    expect(alert.severity).toBe("high");
    expect(alert.when).toBe("Today between 17:00 and 19:00");
    expect(alert.message).toContain("are likely");
  });

  it("treats a hail code as high on its own and says so", () => {
    const w = makeWeather({ code: (i) => (i === 18 ? 96 : 0) });
    const [alert] = placeAlerts(place(w), NOW);
    expect(alert.severity).toBe("high");
    expect(alert.message).toBe(
      "Thunderstorms with hail are likely. If you hear thunder, go indoors.",
    );
    expect(
      placeAlerts(
        place(makeWeather({ code: (i) => (i === 18 ? 99 : 0) })),
        NOW,
      )[0].severity,
    ).toBe("high");
  });

  it("names tomorrow when the storm is after midnight", () => {
    const w = makeWeather({ code: (i) => (i === 33 ? 95 : 0) }); // 09:00 tomorrow
    expect(placeAlerts(place(w), NOW)[0].when).toBe("Tomorrow around 09:00");
  });

  it("uses the thunderstorm insight while it is fresh, with the tuned bands", () => {
    const at = (p: number) =>
      placeAlerts(place(makeWeather({ thunderProbability: p })), NOW);
    expect(at(39)).toEqual([]);
    expect(at(40)[0]).toMatchObject({
      severity: "moderate",
      when: "In the next few hours",
    });
    expect(at(69)[0].severity).toBe("moderate");
    expect(at(70)[0].severity).toBe("high");
  });

  it("does not trust the insight once the forecast is over an hour old", () => {
    const w = makeWeather({ thunderProbability: 90 });
    expect(
      placeAlerts(place(w, { fetchedAt: NOW.getTime() - 2 * HOUR }), NOW),
    ).toEqual([]);
    // The hourly codes still count for an older (but usable) forecast.
    const coded = makeWeather({ code: (i) => (i === 20 ? 95 : 0) });
    expect(
      kinds(
        placeAlerts(place(coded, { fetchedAt: NOW.getTime() - 2 * HOUR }), NOW),
      ),
    ).toEqual(["lightning"]);
  });

  it("ignores thunder beyond the 24 hour window and non-thunder codes", () => {
    expect(
      placeAlerts(
        place(makeWeather({ code: (i) => (i === 45 ? 95 : 0) })),
        NOW,
      ),
    ).toEqual([]);
    expect(placeAlerts(place(makeWeather({ code: () => 65 })), NOW)).toEqual(
      [],
    );
  });
});

describe("flooding (forecast)", () => {
  /** Spread `total` mm over six hours from 17:00 with the heaviest hour `peak`. */
  const rain = (total: number, peak: number) => {
    const rest = (total - peak) / 5;
    return makeWeather({
      precip: (i) => (i === 17 ? peak : i > 17 && i <= 22 ? rest : 0),
    });
  };

  it("stays quiet below both limits", () => {
    expect(placeAlerts(place(rain(39, 10)), NOW)).toEqual([]);
    expect(placeAlerts(place(rain(20, 23.9)), NOW)).toEqual([]);
  });

  it("raises a moderate advisory at 40 mm in the window, or 24 mm in one hour", () => {
    const [byTotal] = placeAlerts(place(rain(40, 10)), NOW);
    expect(byTotal).toMatchObject({
      kind: "flooding",
      level: "advisory",
      severity: "moderate",
      headline: "Flood advisory",
      source: ADVISORY_SOURCE,
      when: "Next 24 hours, heaviest today around 17:00",
    });
    expect(byTotal.message).toBe(
      "Heavy rain is possible: about 40 mm in total, up to 10 mm in one hour. Low-lying ground and roads can flood.",
    );
    expect(placeAlerts(place(rain(30, 24)), NOW)[0].severity).toBe("moderate");
  });

  it("raises a high advisory at 70 mm, or 47 mm in one hour", () => {
    const high = placeAlerts(place(rain(70, 12)), NOW)[0];
    expect(high.severity).toBe("high");
    expect(high.message).toContain("Heavy rain is likely");
    expect(placeAlerts(place(rain(50, 47)), NOW)[0].severity).toBe("high");
  });

  it("counts only rain inside the window and ignores bad values", () => {
    const outside = makeWeather({
      precip: (i) => (i < 16 || i >= 40 ? 100 : 0),
    });
    expect(placeAlerts(place(outside), NOW)).toEqual([]);
    const bad = makeWeather({
      precip: (i) => (i % 2 ? null : -5),
    });
    expect(placeAlerts(place(bad), NOW)).toEqual([]);
  });

  it("says rain, not river or flood levels", () => {
    const [alert] = placeAlerts(place(rain(80, 20)), NOW);
    expect(alert.message).not.toMatch(/river|dam|overflow/i);
  });
});

describe("community reports", () => {
  const report = (
    type: string,
    minutesAgo: number,
    extra: Partial<CommunityReportLike> = {},
  ): CommunityReportLike => ({
    reportType: type,
    severity: "moderate",
    reportedAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    verified: false,
    ...extra,
  });

  it("makes one flooding alert from the reports of the last 24 hours, unverified", () => {
    const alerts = communityAlerts(
      {
        slug: "harare",
        name: "Harare",
        reports: [report("flooding", 30), report("flooding", 90)],
      },
      NOW.getTime(),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: "harare:flooding:community",
      kind: "flooding",
      level: "community",
      severity: "high",
      headline: "Community report: flooding",
      when: "In the last 24 hours",
      asOf: "Latest report 30 min ago",
      source: COMMUNITY_SOURCE,
      reportCount: 2,
    });
    expect(alerts[0].message).toBe(
      "2 people reported flooding near Harare. Do not walk or drive through floodwater.",
    );
    expect(COMMUNITY_SOURCE).toBe("Community report, unverified");
  });

  it("says a single person reported, takes the worst severity, and notes a match with the forecast", () => {
    const [alert] = communityAlerts(
      {
        slug: "harare",
        name: "Harare",
        reports: [
          report("flooding", 5, { severity: "mild" }),
          report("flooding", 6, { severity: "severe", verified: true }),
        ],
      },
      NOW.getTime(),
    );
    expect(alert.severity).toBe("severe");
    expect(alert.source).toBe(COMMUNITY_SOURCE_MATCHED);
    // The same severe report, unverified, never outranks a forecast advisory.
    const [unverified] = communityAlerts(
      {
        slug: "harare",
        name: "Harare",
        reports: [report("flooding", 6, { severity: "severe" })],
      },
      NOW.getTime(),
    );
    expect(unverified.severity).toBe("high");
    expect(unverified.source).toBe(COMMUNITY_SOURCE);
    const [one] = communityAlerts(
      {
        slug: "x",
        name: "X",
        reports: [report("flooding", 5, { severity: "mild" })],
      },
      NOW.getTime(),
    );
    expect(one.message.startsWith("1 person reported flooding near X.")).toBe(
      true,
    );
    expect(one.severity).toBe("moderate");
  });

  it("makes a wildfire alert only from a wildfire report, with advice and no phone number", () => {
    const [alert] = communityAlerts(
      { slug: "mutare", name: "Mutare", reports: [report("wildfire", 12)] },
      NOW.getTime(),
    );
    expect(alert).toMatchObject({
      kind: "wildfire",
      level: "community",
      headline: "Community report: wildfire",
      source: COMMUNITY_SOURCE,
    });
    expect(alert.message).toBe(
      "1 person reported a wildfire near Mutare. If you see flames or smoke close by, move away and call your local emergency services.",
    );
    expect(alert.message).not.toMatch(/\d{3,}/);
  });

  it("never claims a wildfire without a report, whatever the weather", () => {
    const hotDry = makeWeather({ temp: () => 38, precip: () => 0 });
    for (const reports of [
      null,
      [],
      [report("heavy-rain", 5), report("dust", 5)],
    ]) {
      const alerts = placeAlerts(place(hotDry, { reports }), NOW);
      expect(kinds(alerts)).not.toContain("wildfire");
    }
  });

  it("drops reports that are old, in the future, unreadable or of another type", () => {
    const alerts = communityAlerts(
      {
        slug: "harare",
        name: "Harare",
        reports: [
          report("flooding", 25 * 60), // older than 24 h
          report("flooding", -10), // 10 minutes in the future
          { reportType: "flooding", reportedAt: "not a date" },
          report("thunderstorm", 5),
        ],
      },
      NOW.getTime(),
    );
    expect(alerts).toEqual([]);
    // A little clock skew (under a minute) still counts.
    expect(
      communityAlerts(
        { slug: "h", name: "H", reports: [report("flooding", -0.5)] },
        NOW.getTime(),
      ),
    ).toHaveLength(1);
  });

  it("needs no forecast", () => {
    const alerts = placeAlerts(
      place(null, { reports: [report("wildfire", 5)] }),
      NOW,
    );
    expect(kinds(alerts)).toEqual(["wildfire"]);
  });

  it("returns nothing for reports not loaded", () => {
    expect(
      communityAlerts({ slug: "h", name: "H", reports: null }, NOW.getTime()),
    ).toEqual([]);
    expect(
      communityAlerts({ slug: "h", name: "H", reports: [] }, NOW.getTime()),
    ).toEqual([]);
  });
});

describe("wording rules (safety)", () => {
  const scenarios: AlertPlace[] = [
    place(makeWeather({ temp: (i) => (i >= 22 && i <= 30 ? -2 : 15) })),
    place(makeWeather({ code: (i) => (i >= 17 && i <= 20 ? 96 : 0) })),
    place(makeWeather({ precip: (i) => (i === 18 ? 60 : i === 19 ? 30 : 0) })),
    place(makeWeather({ thunderProbability: 80 })),
    place(null, {
      reports: [
        {
          reportType: "wildfire",
          severity: "severe",
          reportedAt: new Date(NOW.getTime() - 60_000).toISOString(),
        },
        {
          reportType: "flooding",
          severity: "severe",
          reportedAt: new Date(NOW.getTime() - 60_000).toISOString(),
        },
      ],
    }),
  ];
  const perScenario = scenarios.map((p) => placeAlerts(p, NOW));
  const all = perScenario.flat();

  it("covers every kind and both levels", () => {
    expect(new Set(all.map((a) => a.kind))).toEqual(new Set(ALERT_KINDS));
    expect(new Set(all.map((a) => a.level))).toEqual(
      new Set(["advisory", "community"]),
    );
  });

  it("calls every forecast alert an advisory from the forecast, not an official warning", () => {
    for (const a of all.filter((x) => x.level === "advisory")) {
      expect(a.headline, a.id).toMatch(/advisory$/);
      expect(a.source, a.id).toBe(ADVISORY_SOURCE);
      expect(a.source).toContain("not an official warning");
      expect(a.asOf, a.id).toMatch(
        /^Forecast as of \d\d:\d\d \(Harare time\)$/,
      );
    }
  });

  it("calls every community alert a community report, unverified unless matched", () => {
    for (const a of all.filter((x) => x.level === "community")) {
      expect(a.headline, a.id).toMatch(/^Community report/);
      expect([COMMUNITY_SOURCE, COMMUNITY_SOURCE_MATCHED]).toContain(a.source);
    }
  });

  it("never promises, guarantees or commands with certainty", () => {
    for (const a of all) {
      const text = `${a.headline} ${a.message} ${a.when} ${a.source}`;
      expect(text, a.id).not.toMatch(
        /guarantee|definitely|certain|\bwill\b|warning!/i,
      );
    }
  });

  it("never writes an emergency or any other phone number", () => {
    for (const a of all) {
      expect(a.message, a.id).not.toMatch(
        /\b(911|999|112|10111|\+?\d[\d ()-]{6,}\d)\b/,
      );
    }
    const fire = all.find((a) => a.kind === "wildfire");
    expect(fire?.message).toContain("call your local emergency services");
  });

  it("gives every alert of a place a unique id", () => {
    for (const alerts of perScenario) {
      const ids = alerts.map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("sortAlerts and collectAlerts", () => {
  const alert = (
    slug: string,
    kind: Alert["kind"],
    severity: Alert["severity"],
    level: Alert["level"] = "advisory",
  ): Alert => ({
    id: `${slug}:${kind}:${level}`,
    kind,
    level,
    severity,
    placeSlug: slug,
    placeName: slug,
    headline: "h",
    message: "m",
    when: "w",
    asOf: "a",
    asOfMs: 0,
    source: "s",
  });

  it("puts the most serious first, advisories before reports, then the places' order, then kind", () => {
    const sorted = sortAlerts(
      [
        alert("b", "frost", "moderate"),
        alert("a", "flooding", "moderate", "community"),
        alert("a", "flooding", "high"),
        alert("a", "lightning", "moderate"),
        alert("a", "frost", "moderate"),
        alert("c", "wildfire", "severe", "community"),
      ],
      ["a", "b", "c"],
    );
    expect(sorted.map((x) => x.id)).toEqual([
      "c:wildfire:community",
      "a:flooding:advisory",
      "a:frost:advisory",
      "a:lightning:advisory",
      "b:frost:advisory",
      "a:flooding:community",
    ]);
  });

  it("collects alerts over places, counting what was checked and when it was fresh", () => {
    const frost = makeWeather({ temp: (i) => (i >= 22 && i <= 30 ? 1 : 15) });
    const storm = makeWeather({ code: (i) => (i === 18 ? 95 : 0) });
    const result = collectAlerts(
      [
        place(frost, { slug: "harare", name: "Harare" }),
        place(storm, {
          slug: "mutare",
          name: "Mutare",
          fetchedAt: NOW.getTime() - 40 * 60_000,
        }),
        place(null, { slug: "gweru", name: "Gweru" }),
        place(frost, {
          slug: "old",
          name: "Old",
          fetchedAt: NOW.getTime() - 9 * HOUR,
        }),
      ],
      NOW,
    );
    expect(result.placesTotal).toBe(4);
    expect(result.placesChecked).toBe(2);
    expect(result.forecastUpdatedAt).toBe(NOW.getTime() - 10 * 60_000);
    expect(result.alerts.map((a) => a.id)).toEqual([
      "harare:frost:advisory", // high
      "mutare:lightning:advisory", // moderate
    ]);
  });

  it("is empty and honest for no places", () => {
    expect(collectAlerts([], NOW)).toEqual({
      alerts: [],
      placesChecked: 0,
      placesTotal: 0,
      forecastUpdatedAt: null,
    });
  });
});

describe("emptyAlertsCopy", () => {
  it("does not say there are no alerts when nothing was checked", () => {
    const copy = emptyAlertsCopy(
      { placesChecked: 0, forecastUpdatedAt: null },
      0,
      0,
    );
    expect(copy.title).toBe("Nothing to check yet");
    expect(copy.title).not.toMatch(/no alerts/i);
    expect(copy.detail).toContain("Open a place");
  });

  it("says when the forecasts it used were last updated, on the viewer's clock", () => {
    const updated = Date.parse("2026-07-10T13:50:00Z");
    const copy = emptyAlertsCopy(
      { placesChecked: 3, forecastUpdatedAt: updated },
      0,
      7200,
    );
    expect(copy.title).toBe("No alerts for your places right now");
    expect(copy.detail).toBe(
      "Checked 3 places, with forecasts last updated at 15:50.",
    );
    expect(
      emptyAlertsCopy({ placesChecked: 1, forecastUpdatedAt: updated }, 0, 0)
        .detail,
    ).toBe("Checked 1 place, with forecasts last updated at 13:50.");
  });

  it("tells the person when alerts exist but a kind is switched off", () => {
    const result = { placesChecked: 2, forecastUpdatedAt: 1_000_000 };
    expect(emptyAlertsCopy(result, 1, 0).detail).toContain(
      "1 alert is hidden because you switched that kind off.",
    );
    expect(emptyAlertsCopy(result, 3, 0).detail).toContain(
      "3 alerts are hidden because you switched that kind off.",
    );
    expect(
      emptyAlertsCopy({ placesChecked: 0, forecastUpdatedAt: null }, 2, 0)
        .detail,
    ).toContain("2 alerts are hidden");
  });
});
