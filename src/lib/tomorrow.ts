/**
 * Tomorrow.io weather API client.
 *
 * Fetches weather data from Tomorrow.io and normalizes it into the existing
 * WeatherData interface so all downstream components work unchanged.
 *
 * Tomorrow.io is the primary provider; Open-Meteo serves as fallback.
 */

import type { WeatherData, CurrentWeather, HourlyWeather, DailyWeather, WeatherInsights } from "./weather";

// ---------------------------------------------------------------------------
// Tomorrow.io weather code → WMO code mapping
// ---------------------------------------------------------------------------

const TOMORROW_TO_WMO: Record<number, number> = {
  1000: 0,   // Clear, Sunny → Clear sky
  1100: 1,   // Mostly Clear → Mainly clear
  1101: 2,   // Partly Cloudy → Partly cloudy
  1102: 3,   // Mostly Cloudy → Overcast
  1001: 3,   // Cloudy → Overcast
  2000: 45,  // Fog → Fog
  2100: 45,  // Light Fog → Fog
  4000: 51,  // Drizzle → Light drizzle
  4001: 63,  // Rain → Moderate rain
  4200: 61,  // Light Rain → Slight rain
  4201: 65,  // Heavy Rain → Heavy rain
  5000: 73,  // Snow → Moderate snow
  5001: 71,  // Flurries → Slight snow
  5100: 71,  // Light Snow → Slight snow
  5101: 75,  // Heavy Snow → Heavy snow
  6000: 66,  // Freezing Drizzle → Light freezing rain
  6001: 67,  // Freezing Rain → Heavy freezing rain
  6200: 66,  // Light Freezing Rain → Light freezing rain
  6201: 67,  // Heavy Freezing Rain → Heavy freezing rain
  7000: 77,  // Ice Pellets → Snow grains
  7101: 77,  // Heavy Ice Pellets → Snow grains
  7102: 77,  // Light Ice Pellets → Snow grains
  8000: 95,  // Thunderstorm → Thunderstorm
};

export function tomorrowCodeToWmo(code: number): number {
  return TOMORROW_TO_WMO[code] ?? 0;
}

// ---------------------------------------------------------------------------
// Tomorrow.io response types (internal)
// ---------------------------------------------------------------------------

interface TomorrowHourlyValues {
  temperature: number;
  humidity: number;
  temperatureApparent: number;
  precipitationProbability: number;
  rainIntensity: number;
  weatherCode: number;
  cloudCover: number;
  windSpeed: number;
  windDirection: number;
  windGust: number;
  uvIndex: number;
  visibility: number;
  pressureSurfaceLevel: number;
  dewPoint: number;
  // Extended core fields for activity insights
  thunderstormProbability?: number;
  ezHeatStressIndex?: number;
  uvHealthConcern?: number;
  precipitationType?: number;
  cloudBase?: number | null;
  cloudCeiling?: number | null;
  evapotranspiration?: number;
}

interface TomorrowDailyValues {
  temperatureMax: number;
  temperatureMin: number;
  temperatureApparentMax?: number;
  temperatureApparentMin?: number;
  weatherCodeMax: number;
  sunriseTime: string;
  sunsetTime: string;
  uvIndexMax: number;
  precipitationProbabilityMax: number;
  windSpeedMax: number;
  windGustMax?: number;
  rainAccumulation?: number;
  snowAccumulation?: number;
  // Extended core fields for activity insights
  moonPhase?: number;
  gdd10To30?: number;
  gdd10To31?: number;
  gdd08To30?: number;
  gdd03To25?: number;
  evapotranspirationAvg?: number;
}

interface TomorrowTimelineEntry<V> {
  time: string;
  values: V;
}

interface TomorrowForecastResponse {
  timelines: {
    hourly: TomorrowTimelineEntry<TomorrowHourlyValues>[];
    daily: TomorrowTimelineEntry<TomorrowDailyValues>[];
  };
  location: { lat: number; lon: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Determine if an hour is daytime based on the daily sunrise/sunset data */
function computeIsDay(
  hourTime: string,
  dailyEntries: TomorrowTimelineEntry<TomorrowDailyValues>[],
): number {
  const t = new Date(hourTime).getTime();

  for (const day of dailyEntries) {
    const sunrise = new Date(day.values.sunriseTime).getTime();
    const sunset = new Date(day.values.sunsetTime).getTime();
    if (t >= sunrise && t <= sunset) return 1;
    // Check if we're on this day (within 24h of sunrise)
    if (Math.abs(t - sunrise) < 24 * 60 * 60 * 1000) {
      return t >= sunrise && t <= sunset ? 1 : 0;
    }
  }
  // Default: check time-of-day heuristic (6am-6pm)
  const hour = new Date(hourTime).getHours();
  return hour >= 6 && hour < 18 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Main fetch + normalize
// ---------------------------------------------------------------------------

const TOMORROW_FORECAST_URL = "https://api.tomorrow.io/v4/weather/forecast";

export async function fetchWeatherFromTomorrow(
  lat: number,
  lon: number,
  apiKey: string,
): Promise<WeatherData> {
  const params = new URLSearchParams({
    location: `${lat},${lon}`,
    timesteps: "1h,1d",
    units: "metric",
    apikey: apiKey,
  });

  const res = await fetch(`${TOMORROW_FORECAST_URL}?${params}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000), // 10s timeout
  });

  if (!res.ok) {
    const status = res.status;
    if (status === 429) {
      throw new TomorrowRateLimitError("Tomorrow.io rate limit exceeded");
    }
    throw new Error(`Tomorrow.io API error: ${status}`);
  }

  const data: TomorrowForecastResponse = await res.json();
  return normalizeTomorrowResponse(data);
}

export class TomorrowRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TomorrowRateLimitError";
  }
}

// ---------------------------------------------------------------------------
// Normalization: Tomorrow.io → WeatherData
// ---------------------------------------------------------------------------

export function normalizeTomorrowResponse(data: TomorrowForecastResponse): WeatherData {
  const { hourly: hourlyEntries, daily: dailyEntries } = data.timelines;

  // --- Current conditions from the first hourly entry ---
  const first = hourlyEntries[0]?.values;
  if (!first) throw new Error("Tomorrow.io returned empty hourly data");

  const current: CurrentWeather = {
    temperature_2m: first.temperature,
    relative_humidity_2m: first.humidity,
    apparent_temperature: first.temperatureApparent,
    precipitation: first.rainIntensity,
    weather_code: tomorrowCodeToWmo(first.weatherCode),
    cloud_cover: first.cloudCover,
    wind_speed_10m: first.windSpeed,
    wind_direction_10m: first.windDirection,
    wind_gusts_10m: first.windGust,
    uv_index: first.uvIndex,
    surface_pressure: first.pressureSurfaceLevel,
    is_day: computeIsDay(hourlyEntries[0].time, dailyEntries),
  };

  // --- Hourly: flatten array-of-objects into parallel arrays ---
  const hourly: HourlyWeather = {
    time: hourlyEntries.map((e) => e.time),
    temperature_2m: hourlyEntries.map((e) => e.values.temperature),
    apparent_temperature: hourlyEntries.map((e) => e.values.temperatureApparent),
    relative_humidity_2m: hourlyEntries.map((e) => e.values.humidity),
    precipitation_probability: hourlyEntries.map((e) => e.values.precipitationProbability),
    precipitation: hourlyEntries.map((e) => e.values.rainIntensity),
    weather_code: hourlyEntries.map((e) => tomorrowCodeToWmo(e.values.weatherCode)),
    visibility: hourlyEntries.map((e) => e.values.visibility * 1000), // km → m (Open-Meteo uses meters)
    cloud_cover: hourlyEntries.map((e) => e.values.cloudCover),
    surface_pressure: hourlyEntries.map((e) => e.values.pressureSurfaceLevel),
    wind_speed_10m: hourlyEntries.map((e) => e.values.windSpeed),
    wind_direction_10m: hourlyEntries.map((e) => e.values.windDirection),
    wind_gusts_10m: hourlyEntries.map((e) => e.values.windGust),
    uv_index: hourlyEntries.map((e) => e.values.uvIndex),
    is_day: hourlyEntries.map((e) => computeIsDay(e.time, dailyEntries)),
  };

  // --- Daily: flatten array-of-objects into parallel arrays ---
  const daily: DailyWeather = {
    time: dailyEntries.map((e) => e.time),
    weather_code: dailyEntries.map((e) => tomorrowCodeToWmo(e.values.weatherCodeMax)),
    temperature_2m_max: dailyEntries.map((e) => e.values.temperatureMax),
    temperature_2m_min: dailyEntries.map((e) => e.values.temperatureMin),
    apparent_temperature_max: dailyEntries.map(
      (e) => e.values.temperatureApparentMax ?? e.values.temperatureMax,
    ),
    apparent_temperature_min: dailyEntries.map(
      (e) => e.values.temperatureApparentMin ?? e.values.temperatureMin,
    ),
    sunrise: dailyEntries.map((e) => e.values.sunriseTime),
    sunset: dailyEntries.map((e) => e.values.sunsetTime),
    uv_index_max: dailyEntries.map((e) => e.values.uvIndexMax),
    precipitation_sum: dailyEntries.map(
      (e) => (e.values.rainAccumulation ?? 0) + (e.values.snowAccumulation ?? 0),
    ),
    precipitation_probability_max: dailyEntries.map((e) => e.values.precipitationProbabilityMax),
    wind_speed_10m_max: dailyEntries.map((e) => e.values.windSpeedMax),
    wind_gusts_10m_max: dailyEntries.map((e) => e.values.windGustMax ?? e.values.windSpeedMax),
  };

  const current_units: Record<string, string> = {
    temperature_2m: "°C",
    relative_humidity_2m: "%",
    apparent_temperature: "°C",
    precipitation: "mm",
    wind_speed_10m: "km/h",
    wind_gusts_10m: "km/h",
    uv_index: "",
    surface_pressure: "hPa",
    cloud_cover: "%",
  };

  // --- Insights: activity-specific data from Tomorrow.io core fields ---
  const today = dailyEntries[0]?.values;
  const insights: WeatherInsights = {
    // Farming — GDD + water loss
    gdd10To30: today?.gdd10To30,
    gdd10To31: today?.gdd10To31,
    gdd08To30: today?.gdd08To30,
    gdd03To25: today?.gdd03To25,
    evapotranspiration: first.evapotranspiration ?? today?.evapotranspirationAvg,
    dewPoint: first.dewPoint,
    precipitationType: first.precipitationType,
    // Safety
    thunderstormProbability: first.thunderstormProbability,
    heatStressIndex: first.ezHeatStressIndex,
    uvHealthConcern: first.uvHealthConcern,
    // Tourism
    moonPhase: today?.moonPhase,
    cloudBase: first.cloudBase,
    cloudCeiling: first.cloudCeiling,
    visibility: first.visibility, // already in km from Tomorrow.io
  };

  return { current, hourly, daily, current_units, insights };
}
