import { describe, it, expect } from "vitest";
import {
  windInsight,
  uvInsight,
  feelsLikeInsight,
  precipitationInsight,
  visibilityInsight,
  humidityInsight,
  pressureInsight,
  sunInsight,
  cloudInsight,
  temperatureAverageInsight,
} from "./metric-insights";
import type {
  WeatherData,
  CurrentWeather,
  HourlyWeather,
  DailyWeather,
} from "./weather";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOURS = 48;

/** Hourly wall-clock strings from 2026-10-08T00:00, one per hour. */
function hourlyTimes(n = HOURS): string[] {
  return Array.from({ length: n }, (_, i) => {
    const h = i % 24;
    const dayOffset = Math.floor(i / 24);
    const day = 8 + dayOffset;
    return `2026-10-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:00`;
  });
}

const fill = <T>(n: number, v: T): T[] => Array.from({ length: n }, () => v);

interface Overrides {
  current?: Partial<CurrentWeather>;
  hourly?: Partial<HourlyWeather>;
  daily?: Partial<DailyWeather>;
}

/**
 * A mild, dry, clear October day. Tests override only what they exercise.
 * Hour 14 is the "now" used by most tests (see NOW below).
 */
function makeWeather(o: Overrides = {}): WeatherData {
  const n = HOURS;
  const times = hourlyTimes(n);
  const isDay = times.map((t) => {
    const h = Number(t.slice(11, 13));
    return h >= 6 && h <= 18 ? 1 : 0;
  });
  const hourly: HourlyWeather = {
    time: times,
    temperature_2m: fill(n, 25),
    apparent_temperature: fill(n, 25),
    relative_humidity_2m: fill(n, 50),
    precipitation_probability: fill(n, 0),
    precipitation: fill(n, 0),
    weather_code: fill(n, 1),
    visibility: fill(n, 25000),
    cloud_cover: fill(n, 20),
    surface_pressure: fill(n, 1012),
    wind_speed_10m: fill(n, 6),
    wind_direction_10m: fill(n, 90),
    wind_gusts_10m: fill(n, 10),
    uv_index: fill(n, 0),
    is_day: isDay,
    ...o.hourly,
  };
  const days = [
    "2026-10-08",
    "2026-10-09",
    "2026-10-10",
    "2026-10-11",
    "2026-10-12",
    "2026-10-13",
    "2026-10-14",
  ];
  const daily: DailyWeather = {
    time: days,
    weather_code: fill(7, 1),
    temperature_2m_max: fill(7, 30),
    temperature_2m_min: fill(7, 18),
    apparent_temperature_max: fill(7, 32),
    apparent_temperature_min: fill(7, 17),
    sunrise: days.map((d) => `${d}T05:20`),
    sunset: days.map((d) => `${d}T17:45`),
    uv_index_max: fill(7, 10),
    precipitation_sum: fill(7, 0),
    precipitation_probability_max: fill(7, 0),
    wind_speed_10m_max: fill(7, 15),
    wind_gusts_10m_max: fill(7, 30),
    ...o.daily,
  };
  const current: CurrentWeather = {
    temperature_2m: 25,
    relative_humidity_2m: 50,
    apparent_temperature: 25,
    precipitation: 0,
    weather_code: 1,
    cloud_cover: 20,
    wind_speed_10m: 6,
    wind_direction_10m: 90,
    wind_gusts_10m: 10,
    uv_index: 0,
    surface_pressure: 1012,
    is_day: 1,
    ...o.current,
  };
  return { current, hourly, daily, current_units: {} };
}

/** A weather object with every array empty — exercises the guard paths. */
function emptyWeather(): WeatherData {
  const empty = {
    time: [],
    temperature_2m: [],
    apparent_temperature: [],
    relative_humidity_2m: [],
    precipitation_probability: [],
    precipitation: [],
    weather_code: [],
    visibility: [],
    cloud_cover: [],
    surface_pressure: [],
    wind_speed_10m: [],
    wind_direction_10m: [],
    wind_gusts_10m: [],
    uv_index: [],
    is_day: [],
  } as unknown as HourlyWeather;
  const emptyDaily = {
    time: [],
    weather_code: [],
    temperature_2m_max: [],
    temperature_2m_min: [],
    apparent_temperature_max: [],
    apparent_temperature_min: [],
    sunrise: [],
    sunset: [],
    uv_index_max: [],
    precipitation_sum: [],
    precipitation_probability_max: [],
    wind_speed_10m_max: [],
    wind_gusts_10m_max: [],
  } as unknown as DailyWeather;
  return {
    current: makeWeather().current,
    hourly: empty,
    daily: emptyDaily,
    current_units: {},
  };
}

/** Local date-time at the given hour and minute on 2026-10-08. */
const at = (h: number, m = 0) => new Date(2026, 9, 8, h, m);
/** Default "now": 14:30 on 2026-10-08 (hourly index 14). */
const NOW = at(14, 30);

/** Typical clear-day UV: rises from 07:00, peaks at 13:00, falls by 19:00. */
const UV_BY_HOUR = [
  0, 0, 0, 0, 0, 0, 0, 1, 2, 4, 6, 8, 9, 10, 9, 8, 6, 4, 2, 1, 0, 0, 0, 0,
];

function uvProfile(): number[] {
  return [...UV_BY_HOUR, ...UV_BY_HOUR];
}

// ---------------------------------------------------------------------------
// Wind
// ---------------------------------------------------------------------------

describe("windInsight", () => {
  it("states the current gust and direction when nothing picks up", () => {
    const w = makeWeather({
      current: {
        wind_speed_10m: 6,
        wind_gusts_10m: 11,
        wind_direction_10m: 67.5,
      },
    });
    const r = windInsight(w, NOW);
    expect(r.speed).toBe(6);
    expect(r.gust).toBe(11);
    expect(r.directionDeg).toBe(67.5);
    expect(r.directionLabel).toBe("ENE");
    expect(r.beaufortLabel).toBe("Light breeze");
    expect(r.sentence).toBe("Gusts up to 11 km/h from the ENE.");
  });

  it("calls out gusts picking up within the next six hours", () => {
    const gusts = fill(HOURS, 12);
    gusts[15] = 40;
    const w = makeWeather({
      current: { wind_gusts_10m: 12 },
      hourly: { wind_gusts_10m: gusts },
    });
    expect(windInsight(w, NOW).sentence).toBe(
      "Gusts picking up to 40 km/h by 15:00.",
    );
  });

  it("ignores a gust rise that is small or below 25 km/h", () => {
    const gusts = fill(HOURS, 12);
    gusts[15] = 20; // +8 over current and below 25 km/h
    const w = makeWeather({
      current: { wind_gusts_10m: 12 },
      hourly: { wind_gusts_10m: gusts },
    });
    expect(windInsight(w, NOW).sentence).toBe(
      "Gusts up to 12 km/h from the E.",
    );
  });

  it("ignores a pick-up beyond the six-hour window", () => {
    const gusts = fill(HOURS, 12);
    gusts[23] = 50; // 9 hours ahead of 14:00
    const w = makeWeather({
      current: { wind_gusts_10m: 12 },
      hourly: { wind_gusts_10m: gusts },
    });
    expect(windInsight(w, NOW).sentence).not.toContain("picking up");
  });

  it("reports calm conditions when speed and gust are near zero", () => {
    const w = makeWeather({
      current: { wind_speed_10m: 0, wind_gusts_10m: 0 },
    });
    expect(windInsight(w, NOW).sentence).toBe("Calm conditions.");
  });

  it("maps speeds onto Beaufort labels", () => {
    expect(
      windInsight(makeWeather({ current: { wind_speed_10m: 0 } }), NOW)
        .beaufortLabel,
    ).toBe("Calm");
    expect(
      windInsight(makeWeather({ current: { wind_speed_10m: 25 } }), NOW)
        .beaufortLabel,
    ).toBe("Moderate breeze");
    expect(
      windInsight(makeWeather({ current: { wind_speed_10m: 120 } }), NOW)
        .beaufortLabel,
    ).toBe("Hurricane force");
  });

  it("labels the direction at the compass extremes", () => {
    expect(
      windInsight(makeWeather({ current: { wind_direction_10m: 0 } }), NOW)
        .directionLabel,
    ).toBe("N");
    expect(
      windInsight(makeWeather({ current: { wind_direction_10m: 225 } }), NOW)
        .directionLabel,
    ).toBe("SW");
  });

  it("does not throw on empty data and falls back to the current block", () => {
    const r = windInsight(emptyWeather(), NOW);
    expect(r.speed).toBe(6);
    expect(r.sentence).toBe("Gusts up to 10 km/h from the E.");
  });

  it("defaults now to the current time when omitted", () => {
    expect(() => windInsight(makeWeather())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// UV
// ---------------------------------------------------------------------------

describe("uvInsight", () => {
  it("says low for the rest of the day when UV stays under 3", () => {
    const w = makeWeather({
      current: { uv_index: 1 },
      hourly: { uv_index: fill(HOURS, 1) },
    });
    const r = uvInsight(w, NOW);
    expect(r.sentence).toBe("Low for the rest of the day.");
    expect(r.label).toBe("Low");
    expect(r.protectFrom).toBeNull();
    expect(r.protectUntil).toBeNull();
    expect(r.positionPct).toBe(9);
  });

  it("gives the sun-protection window through the end of the last high hour", () => {
    const w = makeWeather({
      current: { uv_index: 9 },
      hourly: { uv_index: uvProfile() },
    });
    const r = uvInsight(w, NOW);
    expect(r.peakToday).toBe(10);
    expect(r.peakTime).toBe("13:00");
    expect(r.protectFrom).toBe("09:00");
    expect(r.protectUntil).toBe("18:00");
    expect(r.sentence).toBe("Use sun protection until 18:00.");
  });

  it("gives a future protection window when UV is not yet high", () => {
    const w = makeWeather({
      current: { uv_index: 0 },
      hourly: { uv_index: uvProfile() },
    });
    const r = uvInsight(w, at(6, 30));
    expect(r.sentence).toBe("Use sun protection 09:00–18:00.");
  });

  it("reports low once the day's high UV has passed", () => {
    const w = makeWeather({
      current: { uv_index: 1 },
      hourly: { uv_index: uvProfile() },
    });
    expect(uvInsight(w, at(19, 0)).sentence).toBe(
      "Low for the rest of the day.",
    );
  });

  it("computes position on a 0–11 scale and clamps it", () => {
    expect(
      uvInsight(makeWeather({ current: { uv_index: 11 } }), NOW).positionPct,
    ).toBe(100);
    expect(
      uvInsight(makeWeather({ current: { uv_index: 14 } }), NOW).positionPct,
    ).toBe(100);
    expect(
      uvInsight(makeWeather({ current: { uv_index: 5.5 } }), NOW).positionPct,
    ).toBe(50);
  });

  it("reports unavailable data without throwing", () => {
    const w = emptyWeather();
    const r = uvInsight(
      {
        ...w,
        current: { ...w.current, uv_index: undefined as unknown as number },
      },
      NOW,
    );
    expect(r.sentence).toBe("UV data unavailable.");
  });
});

// ---------------------------------------------------------------------------
// Feels like
// ---------------------------------------------------------------------------

describe("feelsLikeInsight", () => {
  it("blames humidity when it feels clearly warmer and humid", () => {
    const r = feelsLikeInsight(
      makeWeather({
        current: {
          temperature_2m: 30,
          apparent_temperature: 36,
          relative_humidity_2m: 75,
        },
      }),
    );
    expect(r.value).toBe(36);
    expect(r.delta).toBe(6);
    expect(r.sentence).toBe(
      "It feels warmer than the actual temperature, because of the humidity.",
    );
  });

  it("blames wind when it feels clearly cooler and windy", () => {
    const r = feelsLikeInsight(
      makeWeather({
        current: {
          temperature_2m: 18,
          apparent_temperature: 14,
          wind_speed_10m: 25,
        },
      }),
    );
    expect(r.delta).toBe(-4);
    expect(r.sentence).toBe(
      "It feels cooler than the actual temperature, because of the wind.",
    );
  });

  it("describes a warmer feel without a humidity cause when air is dry", () => {
    const r = feelsLikeInsight(
      makeWeather({
        current: {
          temperature_2m: 25,
          apparent_temperature: 29,
          relative_humidity_2m: 40,
        },
      }),
    );
    expect(r.sentence).toBe("It feels warmer than the actual temperature.");
  });

  it("describes a cooler feel without a wind cause in calm air", () => {
    const r = feelsLikeInsight(
      makeWeather({
        current: {
          temperature_2m: 10,
          apparent_temperature: 7,
          wind_speed_10m: 3,
        },
      }),
    );
    expect(r.sentence).toBe("It feels cooler than the actual temperature.");
  });

  it("says similar when the gap is under 2 degrees", () => {
    const r = feelsLikeInsight(
      makeWeather({
        current: { temperature_2m: 25, apparent_temperature: 26 },
      }),
    );
    expect(r.delta).toBe(1);
    expect(r.sentence).toBe("Similar to the actual temperature.");
  });

  it("reports unavailable when the temperature is missing", () => {
    const w = makeWeather();
    const r = feelsLikeInsight({
      ...w,
      current: { ...w.current, temperature_2m: undefined as unknown as number },
    });
    expect(r.sentence).toBe("Feels-like temperature unavailable.");
  });
});

// ---------------------------------------------------------------------------
// Precipitation
// ---------------------------------------------------------------------------

describe("precipitationInsight", () => {
  it("reports dry history and rain likely from a given hour", () => {
    const precip = fill(HOURS, 0);
    precip[16] = 2;
    const w = makeWeather({ hourly: { precipitation: precip } });
    const r = precipitationInsight(w, NOW);
    expect(r.last24hMm).toBe(0);
    expect(r.nextRainTime).toBe("16:00");
    expect(r.sentence).toBe("0 mm in the last 24 h. Rain likely from 16:00.");
  });

  it("says it is raining now and sums the last 24 hours", () => {
    const precip = fill(HOURS, 0.5);
    precip[14] = 1;
    const w = makeWeather({ hourly: { precipitation: precip } });
    const r = precipitationInsight(w, NOW);
    // Hours 0..14 inclusive: 14 × 0.5 + 1
    expect(r.last24hMm).toBe(8);
    expect(r.sentence).toBe("8 mm in the last 24 h. Raining now.");
  });

  it("falls back to the daily total for a rainy later day", () => {
    const dailySum = fill(7, 0);
    dailySum[2] = 6; // Saturday 10 October 2026
    const w = makeWeather({ daily: { precipitation_sum: dailySum } });
    const r = precipitationInsight(w, NOW);
    expect(r.nextRainDay).toBe("Saturday");
    expect(r.sentence).toBe("0 mm in the last 24 h. 6 mm expected Saturday.");
  });

  it("names tomorrow when the rain is tomorrow", () => {
    const dailySum = fill(7, 0);
    dailySum[1] = 3;
    const w = makeWeather({ daily: { precipitation_sum: dailySum } });
    expect(precipitationInsight(w, NOW).sentence).toContain(
      "3 mm expected tomorrow.",
    );
  });

  it("ignores today's daily total because it may already have fallen", () => {
    const dailySum = fill(7, 0);
    dailySum[0] = 5;
    const w = makeWeather({ daily: { precipitation_sum: dailySum } });
    const r = precipitationInsight(w, NOW);
    expect(r.nextRainDay).toBeNull();
    expect(r.sentence).toBe(
      "0 mm in the last 24 h. No rain expected in the next week.",
    );
  });

  it("reports the next-24-hour forecast total", () => {
    const precip = fill(HOURS, 0);
    precip[15] = 1.5;
    precip[20] = 2;
    const w = makeWeather({ hourly: { precipitation: precip } });
    expect(precipitationInsight(w, NOW).next24hMm).toBe(3.5);
  });

  it("does not throw on empty data", () => {
    const r = precipitationInsight(emptyWeather(), NOW);
    expect(r.last24hMm).toBe(0);
    expect(r.nextRainTime).toBeNull();
    expect(r.nextRainDay).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

describe("visibilityInsight", () => {
  const withVis = (metres: number) =>
    makeWeather({ hourly: { visibility: fill(HOURS, metres) } });

  it("reads perfectly clear visibility", () => {
    const r = visibilityInsight(withVis(25000), NOW);
    expect(r.km).toBe(25);
    expect(r.label).toBe("Perfectly clear");
    expect(r.sentence).toBe("Perfectly clear, visibility 25 km.");
  });

  it("calls out haze", () => {
    const r = visibilityInsight(withVis(6000), NOW);
    expect(r.label).toBe("Haze");
    expect(r.sentence).toBe("Haze, visibility 6 km.");
  });

  it("calls out fog clearly", () => {
    const r = visibilityInsight(withVis(500), NOW);
    expect(r.label).toBe("Fog");
    expect(r.sentence).toBe("Fog, visibility 0.5 km.");
  });

  it("reports poor visibility between 1 and 4 km", () => {
    const r = visibilityInsight(withVis(2000), NOW);
    expect(r.label).toBe("Poor");
    expect(r.sentence).toBe("Poor visibility, 2 km.");
  });

  it("maps the label thresholds at their boundaries", () => {
    expect(visibilityInsight(withVis(20000), NOW).label).toBe(
      "Perfectly clear",
    );
    expect(visibilityInsight(withVis(10000), NOW).label).toBe("Clear");
    expect(visibilityInsight(withVis(4000), NOW).label).toBe("Haze");
    expect(visibilityInsight(withVis(1000), NOW).label).toBe("Poor");
    expect(visibilityInsight(withVis(999), NOW).label).toBe("Fog");
  });

  it("warns when fog is forecast within six hours", () => {
    const vis = fill(HOURS, 25000);
    vis[18] = 800;
    const r = visibilityInsight(
      makeWeather({ hourly: { visibility: vis } }),
      NOW,
    );
    expect(r.sentence).toBe(
      "Perfectly clear, visibility 25 km. Fog expected by 18:00.",
    );
  });

  it("warns when haze is forecast within six hours", () => {
    const vis = fill(HOURS, 25000);
    vis[17] = 5000;
    const r = visibilityInsight(
      makeWeather({ hourly: { visibility: vis } }),
      NOW,
    );
    expect(r.sentence).toContain("Haze expected by 17:00.");
  });

  it("reports a general drop when the forecast is poor but not fog or haze", () => {
    const vis = fill(HOURS, 25000);
    vis[16] = 2000;
    const r = visibilityInsight(
      makeWeather({ hourly: { visibility: vis } }),
      NOW,
    );
    expect(r.sentence).toContain("Visibility drops to 2 km by 16:00.");
  });

  it("does not warn about improvement", () => {
    const vis = fill(HOURS, 5000);
    vis[16] = 25000;
    const r = visibilityInsight(
      makeWeather({ hourly: { visibility: vis } }),
      NOW,
    );
    expect(r.sentence).toBe("Haze, visibility 5 km.");
  });

  it("reports unknown visibility when the data is missing", () => {
    const r = visibilityInsight(emptyWeather(), NOW);
    expect(r.km).toBeNull();
    expect(r.label).toBe("Unknown");
    expect(r.sentence).toBe("Visibility data unavailable.");
  });
});

// ---------------------------------------------------------------------------
// Humidity / dew point
// ---------------------------------------------------------------------------

describe("humidityInsight", () => {
  it("gives a muggy dew point at 20 degrees and above", () => {
    const r = humidityInsight(
      makeWeather({
        current: { temperature_2m: 30, relative_humidity_2m: 70 },
      }),
    );
    expect(r.dewPoint).toBe(24);
    expect(r.value).toBe(70);
    expect(r.sentence).toBe("The dew point is 24° right now. Muggy.");
  });

  it("describes dry air at a low dew point", () => {
    const r = humidityInsight(
      makeWeather({
        current: { temperature_2m: 25, relative_humidity_2m: 30 },
      }),
    );
    expect(r.dewPoint).toBe(6);
    expect(r.sentence).toBe("The dew point is 6° right now. Dry.");
  });

  it("describes humid air between 16 and 19 degrees", () => {
    const r = humidityInsight(
      makeWeather({
        current: { temperature_2m: 25, relative_humidity_2m: 65 },
      }),
    );
    expect(r.dewPoint).toBe(18);
    expect(r.sentence).toContain("Humid.");
  });

  it("describes comfortable air between 10 and 15 degrees", () => {
    const r = humidityInsight(
      makeWeather({
        current: { temperature_2m: 22, relative_humidity_2m: 60 },
      }),
    );
    expect(r.dewPoint).toBe(14);
    expect(r.sentence).toContain("Comfortable.");
  });

  it("clamps out-of-range humidity", () => {
    const r = humidityInsight(
      makeWeather({
        current: { temperature_2m: 20, relative_humidity_2m: 150 },
      }),
    );
    expect(r.value).toBe(100);
    expect(r.dewPoint).toBe(20);
  });

  it("reports unavailable data", () => {
    const w = makeWeather();
    const r = humidityInsight({
      ...w,
      current: { ...w.current, relative_humidity_2m: NaN },
    });
    expect(r.sentence).toBe("Humidity data unavailable.");
  });
});

// ---------------------------------------------------------------------------
// Pressure
// ---------------------------------------------------------------------------

describe("pressureInsight", () => {
  it("reads falling pressure as unsettled weather on the way", () => {
    const p = fill(HOURS, 1010);
    p[11] = 1013; // 3 h ago
    p[17] = 1007; // 3 h ahead
    const w = makeWeather({
      current: { surface_pressure: 1010 },
      hourly: { surface_pressure: p },
    });
    const r = pressureInsight(w, NOW);
    expect(r.trend).toBe("falling");
    expect(r.hPa).toBe(1010);
    expect(r.sentence).toBe("Falling — unsettled weather may be on the way.");
  });

  it("reads rising pressure as settled weather", () => {
    const p = fill(HOURS, 1010);
    p[11] = 1007;
    p[17] = 1013;
    const w = makeWeather({
      current: { surface_pressure: 1010 },
      hourly: { surface_pressure: p },
    });
    const r = pressureInsight(w, NOW);
    expect(r.trend).toBe("rising");
    expect(r.sentence).toBe("Rising — settled weather is likely.");
  });

  it("reads small changes as steady", () => {
    const p = fill(HOURS, 1012);
    p[11] = 1011.5;
    p[17] = 1012.5;
    const w = makeWeather({
      current: { surface_pressure: 1012 },
      hourly: { surface_pressure: p },
    });
    const r = pressureInsight(w, NOW);
    expect(r.trend).toBe("steady");
    expect(r.sentence).toBe("Steady — no big change expected.");
  });

  it("falls back to one side of the comparison when the other is missing", () => {
    const p = [1013, 1012, 1011, 1010, 1009, 1008, 1007];
    const w = makeWeather({
      current: { surface_pressure: 1013 },
      hourly: {
        time: hourlyTimes(7),
        surface_pressure: p,
        temperature_2m: fill(7, 20),
        apparent_temperature: fill(7, 20),
        relative_humidity_2m: fill(7, 50),
        precipitation_probability: fill(7, 0),
        precipitation: fill(7, 0),
        weather_code: fill(7, 1),
        visibility: fill(7, 25000),
        cloud_cover: fill(7, 20),
        wind_speed_10m: fill(7, 5),
        wind_direction_10m: fill(7, 90),
        wind_gusts_10m: fill(7, 8),
        uv_index: fill(7, 0),
        is_day: fill(7, 1),
      },
    });
    // now at 00:30 (index 0) so there is no past value; 3 h ahead is 1010.
    const r = pressureInsight(w, at(0, 30));
    expect(r.trend).toBe("falling");
  });

  it("reports unavailable data", () => {
    const w = emptyWeather();
    const r = pressureInsight(
      { ...w, current: { ...w.current, surface_pressure: NaN } },
      NOW,
    );
    expect(r.hPa).toBe(0);
    expect(r.sentence).toBe("Pressure data unavailable.");
  });
});

// ---------------------------------------------------------------------------
// Sun
// ---------------------------------------------------------------------------

describe("sunInsight", () => {
  it("counts down to sunset during the day", () => {
    const r = sunInsight(makeWeather(), at(15, 35));
    expect(r.isDaytime).toBe(true);
    expect(r.nextEventLabel).toBe("Sunset");
    expect(r.nextEventTime).toBe("17:45");
    expect(r.sentence).toBe("Sunset in 2 h 10 min.");
  });

  it("uses minutes only under an hour", () => {
    expect(sunInsight(makeWeather(), at(17, 0)).sentence).toBe(
      "Sunset in 45 min.",
    );
  });

  it("uses whole hours when the remainder is zero", () => {
    expect(sunInsight(makeWeather(), at(14, 45)).sentence).toBe(
      "Sunset in 3 h.",
    );
  });

  it("reports daylight length and arc position during the day", () => {
    const r = sunInsight(makeWeather(), NOW);
    expect(r.sunrise).toBe("05:20");
    expect(r.sunset).toBe("17:45");
    expect(r.daylightHours).toBe(12.4);
    expect(r.arcPct).toBe(74);
  });

  it("counts down to sunrise before dawn, with no arc position", () => {
    const r = sunInsight(makeWeather(), at(4, 0));
    expect(r.isDaytime).toBe(false);
    expect(r.arcPct).toBeNull();
    expect(r.nextEventLabel).toBe("Sunrise");
    expect(r.nextEventTime).toBe("05:20");
    expect(r.sentence).toBe("Sunrise in 1 h 20 min.");
  });

  it("uses tomorrow's sunrise after sunset", () => {
    const sunrise = [
      "2026-10-08T05:20",
      "2026-10-09T05:21",
      ...fill(5, "2026-10-10T05:22"),
    ];
    const r = sunInsight(makeWeather({ daily: { sunrise } }), at(19, 0));
    expect(r.nextEventLabel).toBe("Sunrise");
    expect(r.nextEventTime).toBe("05:21");
    expect(r.sentence).toBe("Sunrise in 10 h 21 min.");
  });

  it("reports unavailable times when the daily data is missing", () => {
    const r = sunInsight(emptyWeather(), NOW);
    expect(r.sunrise).toBeNull();
    expect(r.sentence).toBe("Sunrise and sunset times unavailable.");
  });
});

// ---------------------------------------------------------------------------
// Cloud
// ---------------------------------------------------------------------------

describe("cloudInsight", () => {
  it("predicts clearing after the last cloudy hour", () => {
    const cover = fill(HOURS, 85);
    cover[17] = 20;
    const w = makeWeather({
      current: { cloud_cover: 85 },
      hourly: { cloud_cover: cover },
    });
    const r = cloudInsight(w, NOW);
    expect(r.value).toBe(85);
    expect(r.label).toBe("Mostly cloudy");
    expect(r.sentence).toBe("Clearing after 16:00.");
  });

  it("predicts clouding over when clear skies are about to cloud", () => {
    const cover = fill(HOURS, 10);
    cover[16] = 90;
    const w = makeWeather({
      current: { cloud_cover: 10 },
      hourly: { cloud_cover: cover },
    });
    expect(cloudInsight(w, NOW).sentence).toBe("Clouding over after 15:00.");
  });

  it("states the label when nothing changes", () => {
    const w = makeWeather({
      current: { cloud_cover: 50 },
      hourly: { cloud_cover: fill(HOURS, 50) },
    });
    const r = cloudInsight(w, NOW);
    expect(r.label).toBe("Partly cloudy");
    expect(r.sentence).toBe("Partly cloudy.");
  });

  it("does not throw on empty data", () => {
    const r = cloudInsight(emptyWeather(), NOW);
    expect(r.value).toBe(20);
    expect(r.sentence).toBe("Mostly clear.");
  });
});

// ---------------------------------------------------------------------------
// Temperature against normal
// ---------------------------------------------------------------------------

describe("temperatureAverageInsight", () => {
  it("reports a positive anomaly", () => {
    expect(temperatureAverageInsight(32, 27)).toEqual({
      delta: 5,
      sentence: "+5° above the average daily high",
    });
  });

  it("reports a negative anomaly with a typographic minus", () => {
    expect(temperatureAverageInsight(24, 27)).toEqual({
      delta: -3,
      sentence: "−3° below the average daily high",
    });
  });

  it("reports near-normal when the gap is under one degree", () => {
    expect(temperatureAverageInsight(27.4, 27)).toEqual({
      delta: 0,
      sentence: "Near the average daily high.",
    });
  });

  it("returns null when the normal is unknown", () => {
    expect(temperatureAverageInsight(27, null)).toBeNull();
    expect(temperatureAverageInsight(27, undefined)).toBeNull();
    expect(temperatureAverageInsight(Number.NaN, 27)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

describe("robustness across every insight", () => {
  it("never throws on empty arrays and returns sensible defaults", () => {
    const w = emptyWeather();
    expect(() => {
      windInsight(w, NOW);
      uvInsight(w, NOW);
      feelsLikeInsight(w);
      precipitationInsight(w, NOW);
      visibilityInsight(w, NOW);
      humidityInsight(w);
      pressureInsight(w, NOW);
      sunInsight(w, NOW);
      cloudInsight(w, NOW);
    }).not.toThrow();
  });

  it("handles arrays shorter than the current hour", () => {
    const short = makeWeather({
      hourly: {
        time: hourlyTimes(3),
        uv_index: [0, 1, 2],
        precipitation: [0, 0, 0],
        visibility: [25000, 25000, 25000],
        cloud_cover: [10, 10, 10],
        surface_pressure: [1010, 1010, 1010],
        wind_gusts_10m: [5, 5, 5],
        wind_speed_10m: [5, 5, 5],
        wind_direction_10m: [0, 0, 0],
        precipitation_probability: [0, 0, 0],
        temperature_2m: [20, 20, 20],
        apparent_temperature: [20, 20, 20],
        relative_humidity_2m: [50, 50, 50],
        weather_code: [1, 1, 1],
        is_day: [1, 1, 1],
      },
    });
    expect(() => {
      uvInsight(short, NOW);
      precipitationInsight(short, NOW);
      visibilityInsight(short, NOW);
      pressureInsight(short, NOW);
      cloudInsight(short, NOW);
      windInsight(short, NOW);
    }).not.toThrow();
  });

  it("does not throw when now precedes the forecast", () => {
    const w = makeWeather({ hourly: { uv_index: uvProfile() } });
    const r = uvInsight(w, new Date(2020, 0, 1));
    expect(r.peakToday).toBe(0);
    expect(r.sentence).toBe("Low for the rest of the day.");
  });

  it("supports the full UV profile fixture", () => {
    expect(uvProfile()).toHaveLength(48);
  });
});
