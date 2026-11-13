import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WeatherData } from "./weather";
import type { DashboardPayload } from "./device-weather";
import { HOME_SNAPSHOT_KEY } from "./home-snapshot";
import { renderHook } from "./test-render";
import { useRememberHomeSnapshot } from "./use-home-snapshot";

const HOUR = 3_600_000;
const NOW = Date.now();

/** A forecast that covers now, in a place whose clock is UTC. */
function payload(slug = "west-paddock--ksy4dd7"): DashboardPayload {
  const start = Math.floor(NOW / HOUR) * HOUR - 2 * HOUR;
  const time = Array.from({ length: 96 }, (_, i) =>
    new Date(start + i * HOUR).toISOString().slice(0, 16),
  );
  const s = (v: number) => time.map(() => v);
  const days = Array.from({ length: 5 }, (_, d) =>
    new Date(start + d * 24 * HOUR).toISOString().slice(0, 10),
  );
  const weather = {
    current: {
      temperature_2m: 20,
      relative_humidity_2m: 40,
      apparent_temperature: 19,
      precipitation: 0,
      weather_code: 1,
      cloud_cover: 10,
      wind_speed_10m: 5,
      wind_direction_10m: 90,
      wind_gusts_10m: 9,
      uv_index: 4,
      surface_pressure: 860,
      is_day: 1,
    },
    hourly: {
      time,
      temperature_2m: s(18),
      apparent_temperature: s(17),
      relative_humidity_2m: s(40),
      precipitation_probability: s(0),
      precipitation: s(0),
      weather_code: s(1),
      visibility: s(20000),
      cloud_cover: s(10),
      surface_pressure: s(860),
      wind_speed_10m: s(5),
      wind_direction_10m: s(90),
      wind_gusts_10m: s(9),
      uv_index: s(2),
      is_day: s(1),
    },
    daily: {
      time: days,
      weather_code: days.map(() => 1),
      temperature_2m_max: days.map(() => 27),
      temperature_2m_min: days.map(() => 11),
      apparent_temperature_max: days.map(() => 27),
      apparent_temperature_min: days.map(() => 10),
      sunrise: days.map((d) => `${d}T05:40`),
      sunset: days.map((d) => `${d}T18:10`),
      uv_index_max: days.map(() => 9),
      precipitation_sum: days.map(() => 0),
      precipitation_probability_max: days.map(() => 0),
      wind_speed_10m_max: days.map(() => 20),
    },
    current_units: {},
    utc_offset_seconds: 0,
  } as unknown as WeatherData;
  return {
    location: {
      slug,
      name: "West Paddock",
      province: "Harare",
      lat: -17.83,
      lon: 31.05,
      elevation: 1490,
      tags: ["spot"],
      country: "ZW",
    },
    weather,
    usingFallback: false,
    frostAlert: null,
    season: { name: "Hot dry", localName: "Chirimo", description: "" },
    countryName: "Zimbabwe",
  };
}

interface Props {
  view: DashboardPayload | null;
  isHome: boolean;
}
const useIt = (p: Props) =>
  useRememberHomeSnapshot(p.view, undefined, p.isHome);

const data = new Map<string, string>();
beforeEach(() => {
  data.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const held = () => {
  const raw = data.get(HOME_SNAPSHOT_KEY);
  return raw ? JSON.parse(raw) : null;
};

describe("useRememberHomeSnapshot", () => {
  it("keeps the forecast on screen when the place is the one `/` shows", async () => {
    const view = payload();
    const h = await renderHook(useIt, { initialProps: { view, isHome: true } });
    expect(held()?.slug).toBe("west-paddock--ksy4dd7");
    await h.unmount();
  });

  it("keeps nothing for a place that is not the home place, or while there is no forecast", async () => {
    const h = await renderHook(useIt, {
      initialProps: { view: payload(), isHome: false } as Props,
    });
    expect(held()).toBeNull();
    await h.rerender({ view: null, isHome: true });
    expect(held()).toBeNull();
    await h.unmount();
  });

  it("follows the place on screen: a new home place replaces the copy, and leaving home leaves it alone", async () => {
    const h = await renderHook(useIt, {
      initialProps: { view: payload("a--ksy4dd1"), isHome: true },
    });
    expect(held()?.slug).toBe("a--ksy4dd1");
    // The visitor opens a saved place: the stage is no longer on the home place.
    await h.rerender({ view: payload("b--ksy4dd2"), isHome: false });
    expect(held()?.slug).toBe("a--ksy4dd1");
    // My Location moved (GPS): the copy follows it.
    await h.rerender({ view: payload("c--ksy4dd3"), isHome: true });
    expect(held()?.slug).toBe("c--ksy4dd3");
    await h.unmount();
  });

  it("gives a forecast read back from the device the age it had, not now", async () => {
    const old = NOW - 20 * 60_000;
    const h = await renderHook(
      () => useRememberHomeSnapshot(payload(), old, true),
      {},
    );
    expect(held()?.fetchedAt).toBe(old);
    await h.unmount();
  });

  it("never keeps the seasonal estimate", async () => {
    const h = await renderHook(
      () =>
        useRememberHomeSnapshot(
          { ...payload(), usingFallback: true },
          undefined,
          true,
        ),
      {},
    );
    expect(held()).toBeNull();
    await h.unmount();
  });
});
