import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWeather = vi.fn();
const mockSeason = vi.fn();
vi.mock("@/lib/db", () => ({
  getWeatherForLocation: (...args: unknown[]) => mockWeather(...args),
  getSeasonForDate: (...args: unknown[]) => mockSeason(...args),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));

const { loadLocationWeather, loadLocationPayload } =
  await import("./location-payload");

const LOC = {
  slug: "harare",
  lat: -17.83,
  lon: 31.05,
  elevation: 1490,
  country: "ZW",
};

const WEATHER = {
  timezone: "Africa/Harare",
  utc_offset_seconds: 7200,
  elevation: 1490,
  current: {},
  hourly: { time: [], temperature_2m: [] },
  daily: {},
};

const SEASON = { name: "Dry season" };

beforeEach(() => {
  mockWeather.mockReset();
  mockSeason.mockReset();
  mockSeason.mockResolvedValue(SEASON);
});

describe("loadLocationWeather", () => {
  it("returns the fetched weather with its source, and no fallback", async () => {
    mockWeather.mockResolvedValue({
      data: WEATHER,
      source: "open-meteo:blend",
    });
    const out = await loadLocationWeather(LOC);
    expect(mockWeather).toHaveBeenCalledWith("harare", -17.83, 31.05, 1490);
    expect(out.weather).toBe(WEATHER);
    expect(out.weatherSource).toBe("open-meteo:blend");
    expect(out.usingFallback).toBe(false);
  });

  it("falls back to seasonal estimates and raises no frost alert when the fetch throws", async () => {
    mockWeather.mockRejectedValue(new Error("upstream down"));
    const out = await loadLocationWeather(LOC);
    expect(out.weatherSource).toBe("fallback");
    expect(out.usingFallback).toBe(true);
    expect(out.frostAlert).toBeNull();
    expect(out.weather.hourly).toBeDefined();
  });

  it("treats a fallback source from the fetch as a fallback too", async () => {
    mockWeather.mockResolvedValue({ data: WEATHER, source: "fallback" });
    const out = await loadLocationWeather(LOC);
    expect(out.usingFallback).toBe(true);
    expect(out.frostAlert).toBeNull();
  });
});

describe("loadLocationPayload", () => {
  it("returns weather, frost and the season for the location's country", async () => {
    mockWeather.mockResolvedValue({
      data: WEATHER,
      source: "open-meteo:blend",
    });
    const out = await loadLocationPayload(LOC);
    expect(out.season).toBe(SEASON);
    expect(out.weatherSource).toBe("open-meteo:blend");
    expect(mockSeason).toHaveBeenCalledWith(expect.any(Date), "ZW", -17.83);
  });

  it("still returns the season when the weather falls back", async () => {
    mockWeather.mockRejectedValue(new Error("down"));
    const out = await loadLocationPayload(LOC);
    expect(out.usingFallback).toBe(true);
    expect(out.season).toBe(SEASON);
  });

  it("passes an empty country when the location has none", async () => {
    mockWeather.mockResolvedValue({ data: WEATHER, source: "x" });
    await loadLocationPayload({ ...LOC, country: null });
    expect(mockSeason).toHaveBeenCalledWith(expect.any(Date), "", -17.83);
  });
});
